"""Integration checks against the original native sorting and path-planning core."""
from collections import Counter
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
CACHE = Path(os.environ.get('TMO_CACHE', str(ROOT / '.cache' / 'tmo')))
BINARY = Path(os.environ.get('TMO_BINARY', str(CACHE / 'build' / 'tmo-run')))
SOURCE = Path(os.environ.get('TMO_SOURCE', str(CACHE / 'source')))


class NativeRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not BINARY.exists():
            raise unittest.SkipTest('Native runtime unavailable; run python3 scripts/setup-tmo.py')
        map_path = SOURCE / 'maps/sortation/sortation_33_57_105-chutes.json'
        cls.map = json.loads(map_path.read_text())
        cls.chutes = [i for i, c in enumerate(''.join(cls.map['layout'])) if c == '@']
        cls.mapping = [i % 12 for i in range(len(cls.chutes))]
        # Reserve one recirculation chute while keeping all ordinary destinations.
        cls.mapping = [0 if d == 11 else d for d in cls.mapping]
        cls.mapping[-1] = 11
        cls.demand = [0.03] * 11 + [0.02]
        cls.demand[3] = 0.7
        cls.requests = []
        cls.results = []
        cls.temp = tempfile.TemporaryDirectory()
        for multi in [False, True]:
            mapping = cls.mapping.copy()
            if multi:
                mapping[0] = mapping[48] = 11
            request = dict(map=cls.map, mapping=mapping, demand=cls.demand,
                           agents=600, horizon=1000, seed=17,
                           pickup_wait=2 if multi else 0, dropoff_wait=3 if multi else 0)
            run_dir = Path(cls.temp.name) / str(int(multi))
            run_dir.mkdir()
            input_path, output_path = run_dir / 'input.json', run_dir / 'output.json'
            input_path.write_text(json.dumps(request))
            run = subprocess.run([str(BINARY), str(input_path), str(output_path)],
                                 capture_output=True, text=True, timeout=45)
            if run.returncode:
                raise AssertionError(f'Native evaluation failed: {run.stderr[-1000:]}')
            cls.requests.append(request)
            cls.results.append(json.loads(output_path.read_text()))

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, 'temp'):
            cls.temp.cleanup()

    def test_invalid_mapping_is_rejected_before_simulation(self):
        request = dict(self.requests[0])
        request['mapping'] = [0] * len(self.chutes)
        folder = Path(self.temp.name) / 'invalid'
        folder.mkdir()
        source, output = folder / 'input.json', folder / 'result.json'
        source.write_text(json.dumps(request))
        run = subprocess.run([str(BINARY), str(source), str(output)],
                             capture_output=True, text=True, timeout=10)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn('Every destination needs a chute', run.stderr)
        self.assertFalse(output.exists())

    def test_paths_are_legal_and_collision_free(self):
        cells = ''.join(self.map['layout'])
        width = self.map['n_col']
        for run in self.results:
            positions = run['trace']['positions']
            self.assertEqual(len(positions), 1001)
            for tick, frame in enumerate(positions):
                self.assertEqual(len(frame), 600)
                self.assertEqual(len(set(frame)), 600, f'Vertex conflict at {tick}')
                for cell in frame:
                    self.assertNotIn(cells[cell], '@T')
                if not tick:
                    continue
                previous = positions[tick - 1]
                movement = dict(zip(previous, frame))
                for origin, target in zip(previous, frame):
                    distance = abs(origin // width - target // width) + abs(origin % width - target % width)
                    self.assertLessEqual(distance, 1)
                    if target != origin:
                        self.assertNotEqual(movement.get(target), origin, f'Edge conflict at {tick}')

    def test_parcel_identity_survives_rerouting_and_recirculation(self):
        for request, run in zip(self.requests, self.results):
            mapping = dict(zip(self.chutes, request['mapping']))
            destinations, sorted_ids, recirculated_ids = {}, set(), set()
            saw_repickup = False
            closed = set()
            for event in run['trace']['events']:
                kind = event['type']
                if kind == 'close':
                    closed.add(event['chute'])
                elif kind == 'open':
                    closed.remove(event['chute'])
                if event.get('parcel', -1) < 0:
                    continue
                parcel, destination = event['parcel'], event['destination']
                self.assertGreaterEqual(destination, 0)
                self.assertLess(destination, len(self.demand) - 1)
                self.assertEqual(destinations.setdefault(parcel, destination), destination)
                if kind == 'recirculate':
                    recirculated_ids.add(parcel)
                    self.assertEqual(mapping[event['chute']], len(self.demand) - 1)
                if kind == 'pickup' and parcel in recirculated_ids:
                    saw_repickup = True
                if kind == 'dropoff':
                    self.assertNotIn(event['chute'], closed)
                    self.assertEqual(mapping[event['chute']], destination)
                    self.assertNotIn(parcel, sorted_ids)
                    sorted_ids.add(parcel)
            self.assertGreater(run['metrics']['rerouted'], 0)
            self.assertGreater(run['metrics']['recirculated'], 0)
            self.assertTrue(saw_repickup)
            self.assertIn(3, destinations.values())
            self.assertEqual(len(sorted_ids), run['metrics']['sorted'])

    def test_multiple_recirculation_chutes_are_used_and_remain_open(self):
        request, run = self.requests[1], self.results[1]
        recirculation = {c for c, d in zip(self.chutes, request['mapping']) if d == len(self.demand) - 1}
        used = {e['chute'] for e in run['trace']['events'] if e['type'] == 'recirculate'}
        self.assertEqual(used, recirculation)
        self.assertFalse(any(e['type'] == 'close' and e['chute'] in recirculation
                             for e in run['trace']['events']))
        self.assertGreater(run['metrics']['service_wait_ticks'], 0)
        self.assertGreater(run['metrics']['traffic_wait_ticks'], 0)

    def test_event_supervision_and_throughput_match_executed_records(self):
        for run in self.results:
            counts = Counter(e['type'] for e in run['trace']['events'])
            metrics = run['metrics']
            self.assertEqual(counts['dropoff'], metrics['sorted'])
            self.assertEqual(counts['reroute'], metrics['rerouted'])
            self.assertEqual(counts['recirculate'], metrics['recirculated'])
            self.assertEqual(metrics['throughput'], metrics['sorted'] / metrics['ticks'])
            self.assertEqual(run['trace']['curve'][-1], [metrics['ticks'], metrics['sorted'],
                                                         metrics['recirculated'], metrics['rerouted']])
            self.assertEqual(sum(z['traffic_wait_ticks'] for z in run['zone_metrics']), metrics['traffic_wait_ticks'])
            for zone in run['zone_metrics']:
                self.assertAlmostEqual(zone['traffic_wait_fraction'], zone['traffic_wait_ticks'] / 600000)
                self.assertGreaterEqual(zone['closed_fraction'], 0)
                self.assertLessEqual(zone['closed_fraction'], 1)
            self.assertTrue(metrics['valid'])


if __name__ == '__main__':
    unittest.main()

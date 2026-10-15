import type { Candidate } from './types';

export default function CandidateCurve({
  candidates,
  selectedId,
  onSelect,
}: {
  candidates: Candidate[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const measured = candidates.filter((candidate) => candidate.throughput != null);
  if (!measured.length)
    return (
      <div className="sorting-empty compact">
        Completed evaluations will appear here. Predictions are not measurements.
      </div>
    );
  const width = 700,
    height = 155,
    left = 54,
    right = 22,
    top = 18,
    bottom = 33;
  const maxCalls = Math.max(1, ...measured.map((candidate) => candidate.calls));
  const min = Math.min(...measured.map((candidate) => candidate.throughput!));
  const max = Math.max(...measured.map((candidate) => candidate.throughput!));
  const padding = Math.max((max - min) * 0.2, max * 0.04, 0.001);
  const low = Math.max(0, min - padding),
    high = max + padding;
  const x = (call: number) => left + (call / maxCalls) * (width - left - right);
  const y = (value: number) => top + ((high - value) / (high - low)) * (height - top - bottom);
  let best = -Infinity;
  const points = measured.map((candidate) => {
    best = Math.max(best, candidate.throughput!);
    return `${x(candidate.calls)},${y(best)}`;
  });
  return (
    <div className="sorting-curve" data-testid="candidate-curve">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Measured throughput by cumulative simulation calls"
      >
        {[0, 0.5, 1].map((fraction) => {
          const value = low + (high - low) * fraction;
          return (
            <g key={fraction}>
              <line
                x1={left}
                y1={y(value)}
                x2={width - right}
                y2={y(value)}
                className="curve-grid"
              />
              <text x={left - 9} y={y(value) + 4} textAnchor="end">
                {value.toFixed(3)}
              </text>
            </g>
          );
        })}
        <polyline points={points.join(' ')} className="curve-best" />
        {measured.map((candidate) => (
          <g key={candidate.id}>
            <circle
              cx={x(candidate.calls)}
              cy={y(candidate.throughput!)}
              r={selectedId === candidate.id ? 6 : 4.5}
              className={selectedId === candidate.id ? 'curve-point active' : 'curve-point'}
              role="button"
              tabIndex={0}
              aria-label={`Select ${candidate.id}, ${candidate.throughput!.toFixed(4)} parcels per tick, ${candidate.calls} calls`}
              onClick={() => onSelect(candidate.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(candidate.id);
                }
              }}
            >
              <title>
                {candidate.id}: {candidate.throughput!.toFixed(5)} parcels/tick
              </title>
            </circle>
          </g>
        ))}
        <text x={left} y={height - 8}>
          0
        </text>
        <text x={width - right} y={height - 8} textAnchor="end">
          {maxCalls} calls
        </text>
        <text x={width / 2} y={height - 7} textAnchor="middle">
          True simulation calls · line shows best measured
        </text>
      </svg>
    </div>
  );
}

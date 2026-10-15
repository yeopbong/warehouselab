#include "SortationSystem.h"
#include <chrono>
#include <filesystem>
#include <fstream>
#include <set>

using json = nlohmann::json;

int main(int argc, char** argv) {
    try {
        if (argc != 3) throw std::runtime_error("Usage: tmo-run input.json output.json");
        std::ifstream input(argv[1]);
        json request; input >> request;
        const auto& map_request = request.at("map");
        int rows = map_request.at("n_row").get<int>();
        int cols = map_request.at("n_col").get<int>();
        const auto& layout = map_request.at("layout");
        if (rows < 1 || cols < 1 || layout.size() != rows)
            throw std::runtime_error("Invalid map dimensions");
        for (const auto& row : layout) {
            auto text = row.get<std::string>();
            if (text.size() != cols || text.find_first_not_of(".eTw@") != std::string::npos)
                throw std::runtime_error("Invalid map cells");
        }
        Grid grid;
        grid.load_map_from_json(map_request, 1.0, 1.0);
        auto weights = request.at("demand").get<std::vector<double>>();
        auto assignment = request.at("mapping").get<std::vector<int>>();
        int agents = request.at("agents").get<int>();
        int horizon = request.at("horizon").get<int>();
        unsigned seed = request.at("seed").get<unsigned>();
        if (weights.size() < 2 || assignment.size() != grid.chutes.size())
            throw std::runtime_error("Mapping and demand dimensions do not match the map");
        if (agents < 1 || agents > grid.empty_locations.size() || horizon < 1)
            throw std::runtime_error("Invalid agent count or horizon");
        if (grid.agent_home_locations.empty() || grid.end_points.empty())
            throw std::runtime_error("The sorting map needs workstations and chute endpoints");
        for (int chute : grid.chutes)
            if (grid.obs_adj_endpoints[chute].empty())
                throw std::runtime_error("Every chute needs an adjacent endpoint");
        double demand_sum = 0;
        for (size_t d = 0; d + 1 < weights.size(); ++d) demand_sum += weights[d];
        if (!(demand_sum > 0) || !std::isfinite(demand_sum))
            throw std::runtime_error("Ordinary destination demand must be positive");
        std::map<int, std::vector<int>> mapping;
        for (size_t i = 0; i < assignment.size(); ++i) {
            if (assignment[i] < 0 || assignment[i] >= weights.size())
                throw std::runtime_error("Unknown destination");
            mapping[assignment[i]].push_back(grid.chutes[i]);
        }
        for (size_t d = 0; d < weights.size(); ++d)
            if (mapping[d].empty() || weights[d] < 0 || !std::isfinite(weights[d]))
                throw std::runtime_error("Every destination needs a chute and a finite nonnegative weight");
        std::filesystem::path output_path(argv[2]);
        auto output_directory = output_path.has_parent_path() ? output_path.parent_path() : std::filesystem::path(".");
        std::filesystem::create_directories(output_directory);
        Logger logger;
        auto planner = new MAPFPlanner();
        planner->env->map_name = grid.map_name;
        planner->env->file_storage_path = output_directory.string();
        planner->config = {
            {"lifelong_solver_name", "LaCAM2"}, {"map_weights_path", ""},
            {"max_execution_steps", horizon + 10}, {"max_task_completed", 100000000},
            {"max_agents_in_use", -1}, {"disable_corner_target_agents", false},
            {"LaCAM2", {{"seed", seed}, {"planning_window", 1}, {"execution_window", 1},
                {"use_external_executor", true}, {"consider_rotation", false},
                {"use_orient_in_heuristic", false}, {"use_slow_executor", false},
                {"SUO", {{"vertex_collision_cost",1}, {"iterations",0}, {"max_expanded",-1}, {"window",30}, {"h_weight",1.0}}},
                {"order_strategy","early_time"}, {"disable_agent_strategy","uniform"},
                {"disable_agent_goals",true}, {"tabu_locs_fp",""}}}
        };
        ActionModelWithRotate model(grid); model.set_logger(&logger);
        auto start = std::chrono::steady_clock::now();
        SortationSystem system(grid, planner, &model, mapping, "dist", {}, weights,
            "heuristic+num_agents", {}, 8.0, true,
            request.value("dropoff_wait", 0), request.value("pickup_wait", 0),
            0.0, -1, false, 1, horizon, 2.0, 100.0, agents, seed);
        system.record_trace = request.value("record_trace", true);
        system.set_logger(&logger);
        system.set_num_tasks_reveal(1);
        system.set_plan_time_limit(60);
        system.set_preprocess_time_limit(1800);
        system.simulate(horizon);
        json result = system.research_report();
        result["wall_seconds"] = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
        result["n_recirs"] = system.get_n_recirs();
        result["chute_sleep_count"] = system.get_chute_sleep_count();
        result["total_chute_sleep_time"] = system.get_total_chute_sleep_time();
        std::ofstream out(argv[2]); out << result.dump();
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << std::endl;
        return 1;
    }
}

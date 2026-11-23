#pragma once
#include <string_view>

namespace mundo {
enum class ScriptStatus { ok, invalid_source, syntax_error, memory_limit, time_limit, runtime_error, unsupported_result };
struct ScriptNumber { ScriptStatus status; double value{}; };
// Trusted authoring tools can request one numeric result. This API never accepts bytecode.
[[nodiscard]] ScriptNumber evaluate_number(std::string_view source);
}

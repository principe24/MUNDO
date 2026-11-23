#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

namespace mundo {

using EntityId = std::uint64_t;
using VisualKey = std::uint64_t;
constexpr EntityId root_id = 0;
constexpr std::size_t max_entities = 65'536;
constexpr std::size_t max_depth = 64;
constexpr std::size_t max_world_bytes = 24 * 1024 * 1024;

struct Vec3 { double x{}, y{}, z{}; };
struct Quat { double x{}, y{}, z{}, w{1}; };
struct Transform {
    Vec3 position{};
    Quat rotation{};
    Vec3 scale{1, 1, 1};
};
struct Material {
    std::array<float, 3> linear_rgb{0.45f, 0.60f, 0.64f};
    float roughness{0.55f};
    float metallic{};
    bool operator==(const Material&) const = default;
};
enum class Shape : std::uint8_t { empty, box, cylinder, sphere };
struct Node {
    EntityId id{}, parent{};
    std::string name;
    Transform local{};
    Shape shape{Shape::empty};
    Material material{};
    VisualKey visual{}; // Stable art slot; never conveys physics or authority.
};
using Matrix = std::array<double, 16>; // Column-major. Translation is in slots 12 to 14.
struct CollisionBounds { std::array<double,3> low{}, high{}; };
struct DrawItem {
    EntityId id;
    Shape shape;
    Material material;
    std::array<float, 16> model; // Relative to the frame's double-precision origin.
    VisualKey visual{};
};

// Absolute IDs refer to the document. A creation ordinal is one-based and can
// refer only to an earlier successful create operation in the same batch.
struct EntityReference {
    EntityId value{};
    bool creation_ordinal{};
    static EntityReference existing(EntityId id) { return {id, false}; }
    static EntityReference created(EntityId ordinal) { return {ordinal, true}; }
};
struct CreateEntity {
    EntityReference parent;
    Shape shape{Shape::empty};
    std::string name;
};
struct ChangeEntity {
    EntityReference target;
    std::optional<EntityReference> parent;
    std::optional<std::string> name;
    std::optional<Vec3> position;
    std::optional<Quat> rotation;
    std::optional<Vec3> scale;
    std::optional<Shape> shape;
    std::optional<Material> material;
    std::optional<VisualKey> visual;
};
struct EraseEntity { EntityReference target; };
using WorldEdit = std::variant<CreateEntity, ChangeEntity, EraseEntity>;
constexpr std::size_t max_world_edits = 1024;
struct WorldEditResult {
    // Zero-based index of the rejected edit, or the first beyond the batch limit.
    std::optional<std::size_t> rejected;
    // IDs in creation order (including those later erased). Empty on rejection.
    std::vector<EntityId> created;
};

class World {
public:
    [[nodiscard]] EntityId create(std::string name, EntityId parent = root_id, Shape shape = Shape::empty);
    [[nodiscard]] bool edit(const Node& node);
    [[nodiscard]] bool erase_subtree(EntityId id);
    // Sequential edits commit together. Failure preserves every node and the ID allocator.
    [[nodiscard]] WorldEditResult apply_edits(std::span<const WorldEdit> edits);
    // Canonical persisted contents, including the entity ID allocator.
    [[nodiscard]] std::string revision() const;
    // nullopt means stale revision. A present result describes the batch's edits.
    // As for other World mutations, the owner must serialize access to this instance.
    [[nodiscard]] std::optional<WorldEditResult> apply_edits_if(std::string_view expected,
                                                                std::span<const WorldEdit> edits);
    // Inserts a complete source beneath a fresh group. Existing IDs and visual keys are preserved in the destination.
    [[nodiscard]] EntityId place(const World& source, std::string name, const Transform& placement = {},
                                 EntityId parent = root_id);
    [[nodiscard]] const Node* get(EntityId id) const;
    [[nodiscard]] const std::map<EntityId, Node>& nodes() const noexcept { return nodes_; }
    // Copy complete top-level families of an already validated world, keeping IDs and transforms.
    [[nodiscard]] World select_families(std::span<const EntityId> roots) const;
    void copy_local_pose(EntityId, const World& source);
    [[nodiscard]] EntityId first_solid_family() const;
    [[nodiscard]] bool family_fits_cell(EntityId root,std::int32_t x,std::int32_t z) const;
    [[nodiscard]] Matrix transform_matrix(EntityId id) const; // root_id is the identity.
    [[nodiscard]] std::vector<CollisionBounds> static_collision_bounds(EntityId excluded_subtree=root_id) const;
    [[nodiscard]] std::vector<DrawItem> visible(Vec3 origin, double distance) const;
    // Validates and commits a complete document atomically, including forward parent references.
    [[nodiscard]] static std::optional<World> restore(std::vector<Node> nodes, EntityId next);
    // Consume independent, validated documents from one publication, preserving IDs and complete families.
    [[nodiscard]] static std::optional<World> merge_documents(std::vector<World>&& parts);
    [[nodiscard]] EntityId next_id() const noexcept { return next_; }
private:
    std::map<EntityId, Node> nodes_;
    std::map<EntityId, std::vector<EntityId>> children_;
    EntityId next_{1};
};

[[nodiscard]] std::vector<std::byte> encode(const World& world);
[[nodiscard]] std::optional<World> decode(std::span<const std::byte> bytes);

} // namespace mundo

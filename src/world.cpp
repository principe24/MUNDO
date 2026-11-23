#include "mundo/world.hpp"
#include "valid_name.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

namespace mundo {
namespace {
using Index = std::map<EntityId, std::vector<EntityId>>;
constexpr Matrix identity{1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1};
bool finite(double n, double limit) { return std::isfinite(n) && std::abs(n) <= limit; }
bool valid(const Node& node) {
    const auto& t = node.local;
    const auto& q = t.rotation;
    const double norm = q.x*q.x + q.y*q.y + q.z*q.z + q.w*q.w;
    const auto scale = [](double n) { return n >= 0.0001 && n <= 10000; };
    const auto unit = [](float n) { return n >= 0 && n <= 1; };
    return node.id != root_id && valid_name(node.name,95) && node.shape <= Shape::sphere &&
        finite(t.position.x, 1e12) && finite(t.position.y, 1e12) && finite(t.position.z, 1e12) &&
        std::abs(norm - 1.0) <= 1e-5 && scale(t.scale.x) && scale(t.scale.y) && scale(t.scale.z) &&
        std::all_of(node.material.linear_rgb.begin(), node.material.linear_rgb.end(), unit) &&
        unit(node.material.roughness) && unit(node.material.metallic);
}
Index children(const std::map<EntityId,Node>& nodes) {
    Index result;
    for (const auto& [id,node] : nodes) result[node.parent].push_back(id);
    return result;
}
bool valid_tree(const Index& index, std::size_t node_count) {
    std::vector<std::pair<EntityId,std::size_t>> pending{{root_id,0}};
    std::size_t visited = 0;
    while (!pending.empty()) {
        auto [id,depth] = pending.back(); pending.pop_back();
        if (depth > max_depth) return false;
        if (id != root_id) ++visited;
        if (auto iter = index.find(id); iter != index.end()) {
            for (auto child : iter->second) pending.emplace_back(child, depth+1);
        }
    }
    return visited == node_count;
}
Matrix local_matrix(const Transform& tr) {
    auto [x,y,z,w] = tr.rotation;
    const double n=1.0/std::sqrt(x*x+y*y+z*z+w*w);
    x*=n; y*=n; z*=n; w*=n;
    const auto [sx,sy,sz]=tr.scale;
    return {(1-2*(y*y+z*z))*sx, 2*(x*y+z*w)*sx, 2*(x*z-y*w)*sx, 0,
        2*(x*y-z*w)*sy, (1-2*(x*x+z*z))*sy, 2*(y*z+x*w)*sy, 0,
        2*(x*z+y*w)*sz, 2*(y*z-x*w)*sz, (1-2*(x*x+y*y))*sz, 0,
        tr.position.x,tr.position.y,tr.position.z,1};
}
Matrix multiply(const Matrix& a, const Matrix& b) {
    Matrix result{};
    for (unsigned c=0;c<4;++c) for (unsigned r=0;r<4;++r)
        for (unsigned k=0;k<4;++k) result[c*4+r] += a[k*4+r]*b[c*4+k];
    return result;
}
template<class Visitor>
void visit_transforms(const std::map<EntityId,Node>& nodes, const Index& index, Visitor visit, EntityId skip=root_id) {
    std::vector<std::pair<EntityId,Matrix>> pending{{root_id,identity}};
    while (!pending.empty()) {
        const auto [id,world]=pending.back(); pending.pop_back();
        const auto iter=index.find(id);
        if (iter==index.end()) continue;
        for (auto child:iter->second) {
            if(child==skip)continue;
            const auto& node=nodes.at(child);
            const Matrix composed=multiply(world,local_matrix(node.local));
            pending.emplace_back(child,composed);
            visit(node, composed);
        }
    }
}

// Decoded worlds have a validated maximum depth of 64. Each invocation visits only one family.
template<class Visitor>
bool every_family_node(const std::map<EntityId,Node>& nodes,const Index& index,EntityId id,
                       const Matrix& parent,Visitor& accept){
    const auto& node=nodes.at(id);
    const auto world=multiply(parent,local_matrix(node.local));
    if(!accept(node,world))return false;
    const auto children=index.find(id);
    if(children!=index.end())for(const auto child:children->second)
        if(!every_family_node(nodes,index,child,world,accept))return false;
    return true;
}
}
const Node* World::get(EntityId id) const {
    const auto iter=nodes_.find(id);
    return iter==nodes_.end() ? nullptr : &iter->second;
}
EntityId World::first_solid_family() const{
    const auto roots=children_.find(root_id);
    if(roots==children_.end())return root_id;
    // Studio visits all immediate children before popping the last pending family.
    for(const auto id:roots->second)if(nodes_.at(id).shape!=Shape::empty)return id;
    const auto no_solid=[](const Node& n,const Matrix& m){
        return n.shape==Shape::empty || !std::all_of(m.begin(),m.end(),[](double v){return finite(v,1e19);});
    };
    for(auto it=roots->second.rbegin();it!=roots->second.rend();++it)
        if(!every_family_node(nodes_,children_,*it,identity,no_solid))return *it;
    return root_id;
}
bool World::family_fits_cell(EntityId root,std::int32_t x,std::int32_t z) const{
    const auto* top=get(root);
    if(!top || top->parent!=root_id || top->name.starts_with("MUNDO/Circuito/v1/") ||
       top->name.starts_with("Portal/"))return false;
    bool drawable=false;
    const auto within=[&](const Node& n,const Matrix& m){
        if(n.name=="Chasis" || !std::all_of(m.begin(),m.end(),[](double v){return finite(v,1e19);}))return false;
        if(n.shape==Shape::empty && !n.visual)return true;
        // Both native published art and primitive geometry fit the centered unit box,
        // including visual-only nodes that have no static collision proxy.
        drawable=true;
        for(const auto axis:{0u,2u}){
            const double extent=.5*(std::abs(m[axis])+std::abs(m[axis+4])+std::abs(m[axis+8]));
            const double center=m[12+axis];
            const auto cell=axis==0?x:z;
            if(std::floor((center-extent)/64.+.5)!=cell || std::floor((center+extent)/64.+.5)!=cell)
                return false;
        }
        return true;
    };
    return every_family_node(nodes_,children_,root,identity,within) && drawable;
}
World World::select_families(std::span<const EntityId> roots) const {
    World selected;
    selected.next_=next_;
    std::vector<EntityId> pending;
    for(const auto root:roots){
        const Node* top=get(root);
        if(!top || top->parent!=root_id)continue;
        pending.push_back(root);
        while(!pending.empty()){
            const auto id=pending.back();pending.pop_back();
            const auto& node=nodes_.at(id);
            if(!selected.nodes_.emplace(id,node).second)continue;
            selected.children_[node.parent].push_back(id);
            if(const auto it=children_.find(id);it!=children_.end())
                pending.insert(pending.end(),it->second.rbegin(),it->second.rend());
        }
    }
    return selected;
}
void World::copy_local_pose(EntityId id,const World& source){
    auto own=nodes_.find(id);
    const auto* other=source.get(id);
    if(own!=nodes_.end() && other && own->second.parent==other->parent)
        own->second.local=other->local;
}
EntityId World::place(const World& source, std::string name, const Transform& placement, EntityId parent) {
    const auto needed=source.nodes_.size()+1;
    if (source.nodes_.empty() || needed>max_entities-nodes_.size() ||
        needed>std::numeric_limits<EntityId>::max()-next_) return root_id;
    const EntityId group=next_;
    Node group_node{group,parent,std::move(name),placement,Shape::empty,{}};
    if (!valid(group_node) || (parent!=root_id && !get(parent))) return root_id;
    std::vector<Node> combined;
    combined.reserve(nodes_.size()+needed);
    for (const auto& entry:nodes_) combined.push_back(entry.second);
    combined.push_back(std::move(group_node));
    std::map<EntityId,EntityId> remap{{root_id,group}};
    EntityId next=group+1;
    for (const auto& entry:source.nodes_) remap.emplace(entry.first,next++);
    for (const auto& [id,node]:source.nodes_) {
        auto copy=node;
        copy.id=remap.at(id);
        copy.parent=remap.at(node.parent);
        combined.push_back(std::move(copy));
    }
    auto candidate=restore(std::move(combined),next);
    if (!candidate) return root_id;
    *this=std::move(*candidate);
    return group;
}
EntityId World::create(std::string name, EntityId parent, Shape shape) {
    if (nodes_.size()>=max_entities || next_==std::numeric_limits<EntityId>::max()) return root_id;
    std::size_t depth=1;
    for (auto id=parent;id!=root_id;) {
        const Node* n=get(id);
        if (!n || ++depth>max_depth) return root_id;
        id=n->parent;
    }
    Node node{next_,parent,std::move(name),{},shape,{}};
    if (!valid(node)) return root_id;
    nodes_.emplace(next_,std::move(node));
    try {
        children_[parent].push_back(next_);
    } catch (...) {
        nodes_.erase(next_);
        throw;
    }
    return next_++;
}
bool World::edit(const Node& node) {
    auto iter=nodes_.find(node.id);
    if (iter==nodes_.end() || !valid(node)) return false;
    if (node.parent!=iter->second.parent) {
        if (node.parent!=root_id && !get(node.parent)) return false;
        // A reparent changes the depths of all descendants; validate before committing.
        auto candidate=nodes_;
        candidate.at(node.id)=node;
        auto next_children=children(candidate);
        if (!valid_tree(next_children,candidate.size())) return false;
        nodes_.swap(candidate);
        children_.swap(next_children);
    } else iter->second=node;
    return true;
}
bool World::erase_subtree(EntityId id) {
    const auto* node=get(id);
    if (!node) return false;
    auto& siblings=children_.at(node->parent);
    std::erase(siblings,id);
    std::vector<EntityId> pending{id};
    while (!pending.empty()) {
        const auto current=pending.back(); pending.pop_back();
        if (auto it=children_.find(current);it!=children_.end()) {
            pending.insert(pending.end(),it->second.begin(),it->second.end());
            children_.erase(it);
        }
        nodes_.erase(current);
    }
    return true;
}
WorldEditResult World::apply_edits(std::span<const WorldEdit> edits) {
    if (edits.size() > max_world_edits) return {max_world_edits, {}};
    if (edits.empty()) return {};
    World staged = *this;
    WorldEditResult result;
    const auto resolve = [&](const EntityReference& ref) -> std::optional<EntityId> {
        if (!ref.creation_ordinal) return ref.value;
        if (ref.value == 0 || ref.value > result.created.size()) return {};
        return result.created[static_cast<std::size_t>(ref.value - 1)];
    };
    for (std::size_t index = 0; index < edits.size(); ++index) {
        const auto& edit = edits[index];
        if (const auto* create = std::get_if<CreateEntity>(&edit)) {
            const auto parent = resolve(create->parent);
            if (!parent) return {index, {}};
            const auto id = staged.create(create->name, *parent, create->shape);
            if (id == root_id) return {index, {}};
            result.created.push_back(id);
        } else if (const auto* change = std::get_if<ChangeEntity>(&edit)) {
            const auto target = resolve(change->target);
            const auto* current = target ? staged.get(*target) : nullptr;
            if (!current) return {index, {}};
            Node updated = *current;
            if (change->parent) {
                const auto parent = resolve(*change->parent);
                if (!parent) return {index, {}};
                updated.parent = *parent;
            }
            if (change->name) updated.name = *change->name;
            if (change->position) updated.local.position = *change->position;
            if (change->rotation) updated.local.rotation = *change->rotation;
            if (change->scale) updated.local.scale = *change->scale;
            if (change->shape) updated.shape = *change->shape;
            if (change->material) updated.material = *change->material;
            if (change->visual) updated.visual = *change->visual;
            if (!staged.edit(updated)) return {index, {}};
        } else {
            const auto target = resolve(std::get<EraseEntity>(edit).target);
            if (!target || !staged.erase_subtree(*target)) return {index, {}};
        }
    }
    *this = std::move(staged);
    return result;
}
std::optional<World> World::restore(std::vector<Node> nodes, EntityId next) {
    if (nodes.size()>max_entities || next==root_id) return {};
    World out;
    for (auto& node:nodes) {
        if (!valid(node) || node.id>=next) return {};
        if (!out.nodes_.emplace(node.id,std::move(node)).second) return {};
    }
    out.children_=children(out.nodes_);
    if (!valid_tree(out.children_,out.nodes_.size())) return {};
    out.next_=next;
    return out;
}
std::optional<World> World::merge_documents(std::vector<World>&& parts){
    if(parts.empty())return {};
    World merged;
    merged.next_=parts.front().next_;
    std::size_t count=0;
    for(const auto& part:parts){
        if(part.next_!=merged.next_ || part.nodes_.size()>max_entities-count)return {};
        count+=part.nodes_.size();
    }
    std::vector<EntityId> ids,roots;
    ids.reserve(count);
    for(const auto& part:parts){
        for(const auto& [id,node]:part.nodes_){
            ids.push_back(id);
            if(node.parent==root_id)roots.push_back(id);
        }
    }
    std::sort(ids.begin(),ids.end());
    if(std::adjacent_find(ids.begin(),ids.end())!=ids.end())return {};
    std::sort(roots.begin(),roots.end());
    if(!roots.empty())merged.children_.emplace(root_id,std::move(roots));
    // All checks and allocations precede the ownership transfer. Map nodes and strings are reused.
    for(auto& part:parts){
        merged.nodes_.merge(part.nodes_);
        part.children_.erase(root_id);
        merged.children_.merge(part.children_);
    }
    return merged;
}
Matrix World::transform_matrix(EntityId id) const {
    Matrix result=identity;
    while (id!=root_id) {
        const auto& node=nodes_.at(id);
        result=multiply(local_matrix(node.local),result);
        id=node.parent;
    }
    return result;
}
std::vector<CollisionBounds> World::static_collision_bounds(EntityId excluded_subtree) const {
    std::vector<CollisionBounds> boxes;
    visit_transforms(nodes_, children_, [&](const Node& node, const Matrix& m) {
        if (node.shape == Shape::empty) return;
        CollisionBounds box;
        for (unsigned axis=0; axis<3; ++axis) {
            const double extent=.5*(std::abs(m[axis])+std::abs(m[axis+4])+std::abs(m[axis+8]));
            box.low[axis]=m[12+axis]-extent;
            box.high[axis]=m[12+axis]+extent;
            if (!finite(box.low[axis],1e15) || !finite(box.high[axis],1e15)) return;
        }
        boxes.push_back(box);
    },excluded_subtree);
    return boxes;
}
std::vector<DrawItem> World::visible(Vec3 origin, double distance) const {
    std::vector<DrawItem> result;
    if (!finite(origin.x,1e15)||!finite(origin.y,1e15)||!finite(origin.z,1e15)||!std::isfinite(distance)||distance<=0) return result;
    visit_transforms(nodes_,children_,[&](const Node& node, const Matrix& composed){
            if (node.shape==Shape::empty && !node.visual) return;
            Matrix relative=composed;
            relative[12]-=origin.x; relative[13]-=origin.y; relative[14]-=origin.z;
            if (!std::all_of(relative.begin(),relative.end(),[](double n){return finite(n,1e19);})) return;
            // Unit primitives fit inside [-.5,.5]^3, including non-uniform parent scales.
            const double radius=0.5*(std::hypot(relative[0],relative[1],relative[2])+
                std::hypot(relative[4],relative[5],relative[6])+std::hypot(relative[8],relative[9],relative[10]));
            if (std::hypot(relative[12],relative[13],relative[14])>distance+radius) return;
            DrawItem item{node.id,node.shape,node.material,{},node.visual};
            std::transform(relative.begin(),relative.end(),item.model.begin(),[](double n){return static_cast<float>(n);});
            result.push_back(item);
    });
    return result;
}
} // namespace mundo

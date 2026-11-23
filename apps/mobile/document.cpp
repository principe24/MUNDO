#include "document.hpp"
#ifdef MUNDO_NATIVE_PROJECT_FILES
#include "room_http.hpp"
#endif
#include <algorithm>
#include <cstring>
#include <fstream>

namespace mundo::mobile {
namespace {
Vec3 preferred(const World& world){
    for(const auto& [id,node]:world.nodes())if(node.parent==root_id)
        return {node.local.position.x,node.local.position.y+.6,node.local.position.z+9};
    return {0,.6,9};
}
}
std::unique_ptr<PlayDocument> prepare_document(const std::filesystem::path& path,bool restore,
                                               std::optional<project::Selection> destination){
    try{
        std::ifstream file(path,std::ios::binary|std::ios::ate);
        auto end=file.tellg();
        if(end<24||end>static_cast<std::streamoff>(max_package_bytes))return {};
        const auto size=static_cast<std::size_t>(end);
        file.seekg(0);char magic[8];
        if(!file.read(magic,sizeof(magic)))return {};
        const bool paged=std::memcmp(magic,"MZONES01",8)==0;
        auto doc=std::make_unique<PlayDocument>();
        doc->path=path;
        file.seekg(0);
#ifdef MUNDO_NATIVE_PROJECT_FILES
        if(std::string_view(magic,sizeof(magic))==project::signature) {
            auto open=[&]() -> project::Scene {
                if(restore && !destination) {
                    if(auto saved=read_project_location(path.parent_path())) {
                        try { return project::read_scene(file,room::matches_digest,saved); }
                        catch(const project::DestinationChanged&) { file.clear(); }
                    }
                }
                return project::read_scene(file,room::matches_digest,destination);
            };
            auto initial=open();
            doc->project_caption=initial.game_name+" · "+initial.world_title;
            const auto key="MUNDOPRJ/"+initial.index_hash+"/"+std::to_string(initial.id);
            doc->key=document_key(std::as_bytes(std::span(key)));
            doc->location=project::Selection{std::move(initial.index_hash),initial.id};
            doc->destinations=std::move(initial.worlds);
            doc->portals=std::move(initial.portals);
            doc->world=std::move(initial.world);
            doc->vehicles=std::move(initial.vehicles);
            doc->terrain.emplace(std::move(initial.terrain));
            doc->character=initial.character;
            if(restore) {
                auto pose=read_pose(path.parent_path(),doc->key);
                if(pose && pose->location==doc->location && doc->character.resume_at(*doc->terrain,pose->feet)) {
                    doc->yaw=pose->yaw; doc->pitch=pose->pitch;
                }
            }
            return doc;
        }
#endif
        if(destination)return {};
        if(size>(paged?max_zones_bytes:max_world_bytes))return {};
        if(paged){
            // Match the legacy pose key while keeping only a bounded hash buffer in memory.
            std::array<char,32768> block;doc->key=14695981039346656037ULL;
            for(std::size_t left=size;left;){
                auto n=std::min(left,block.size());if(!file.read(block.data(),n))return {};
                for(std::size_t i=0;i<n;++i){doc->key^=static_cast<unsigned char>(block[i]);doc->key*=1099511628211ULL;}
                left-=n;
            }
            doc->zones=ZoneArchive::open(path);if(!doc->zones)return {};
        }else{
            std::vector<std::byte> bytes(size);
            if(!file.read(reinterpret_cast<char*>(bytes.data()),size))return {};
            auto world=decode(bytes);if(!world)return {};
            doc->world=std::move(*world);doc->key=document_key(bytes);
        }
        auto pose=restore?read_pose(path.parent_path(),doc->key):std::nullopt;
        auto spawn=preferred(paged?doc->zones->permanent():doc->world);
        if(paged){
            CharacterTerrain base(doc->zones->permanent());doc->character.spawn(base,spawn);
            spawn=doc->character.feet();
        }
        // A previous position may be in a distant cell. Load its terrain before checking clearance.
        auto populate=[&](Vec3 at){
            if(paged){
                auto scene=doc->zones->select(at,1);
                if(!scene)return false;
                doc->world=std::move(*scene);
            }
            doc->terrain.emplace(doc->world);return true;
        };
        if(!populate(spawn))return {};
        doc->character.spawn(*doc->terrain,spawn);
        if(pose){
            bool moved=paged&&doc->zones->needs(pose->feet,1);
            if((!moved||populate(pose->feet))&&doc->character.resume_at(*doc->terrain,pose->feet)){
                doc->yaw=pose->yaw;doc->pitch=pose->pitch;
            }else if(moved&&!populate(spawn))return {};
        }
        doc->vehicles.discover(doc->world);return doc;
    }catch(...){return {};}
}
}

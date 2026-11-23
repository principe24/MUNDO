#include "mundo/avatar.hpp"
#include "mundo/vehicle.hpp"
#ifdef MUNDO_OWNER_VEHICLE_ART
#include "owner_vehicle_art.hpp"
#endif
#include "mundo/graphics.hpp"
#include <filament/Camera.h>
#include <filament/Engine.h>
#include <filament/IndexBuffer.h>
#include <filament/LightManager.h>
#include <filament/Material.h>
#include <filament/MaterialInstance.h>
#include <filament/RenderableManager.h>
#include <filament/Renderer.h>
#include <filament/Scene.h>
#include <filament/SwapChain.h>
#include <filament/Texture.h>
#include "../platform/display.hpp"
#include <filament/TransformManager.h>
#include <filament/VertexBuffer.h>
#include <filament/View.h>
#include <filament/Viewport.h>
#include <math/mat3.h>
#include <math/mat4.h>
#include <math/quat.h>
#include <utils/EntityManager.h>
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <map>
#include <tuple>
#include <utility>

namespace mundo {
namespace f=filament;
namespace m=filament::math;
namespace {
struct GpuVertex { m::float3 position; m::float4 frame; };
struct Geometry { f::VertexBuffer* vertices{}; f::IndexBuffer* indices{}; std::uint64_t last_seen{}; };
using GeometryKey=std::tuple<VisualKey,Shape,unsigned,bool>;
enum class ItemGroup { world, local_avatar, peer_avatar };
struct Item {
    utils::Entity entity{};
    std::vector<f::MaterialInstance*> materials;
    GeometryKey geometry{};
    std::uint64_t last_seen{};
    std::optional<Material> applied_material;
    std::optional<std::array<float,16>> applied_transform;
    Detail mesh_detail{Detail::balanced};
};
template<class T> void release_vector(void*,std::size_t,void* user){delete static_cast<std::vector<T>*>(user);}
Geometry upload(f::Engine& engine,const Mesh& mesh){
    if(!valid_mesh(mesh))return {};
    auto vertices=std::make_unique<std::vector<GpuVertex>>();
    vertices->reserve(mesh.vertices.size());
    for(const auto& v:mesh.vertices){
        m::float3 n{v.normal[0],v.normal[1],v.normal[2]};
        m::float3 axis=std::abs(n.y)<.9f?m::float3{0,1,0}:m::float3{1,0,0};
        const auto tangent=normalize(cross(axis,n)),bitangent=cross(n,tangent);
        const auto q=m::mat3f::packTangentFrame(m::mat3f{tangent,bitangent,n});
        vertices->push_back({{v.position[0],v.position[1],v.position[2]},q.xyzw});
    }
    auto indices=std::make_unique<std::vector<std::uint32_t>>(mesh.indices);
    auto* vb=f::VertexBuffer::Builder().vertexCount(static_cast<std::uint32_t>(vertices->size())).bufferCount(1)
        .attribute(f::VertexAttribute::POSITION,0,f::VertexBuffer::AttributeType::FLOAT3,offsetof(GpuVertex,position),sizeof(GpuVertex))
        .attribute(f::VertexAttribute::TANGENTS,0,f::VertexBuffer::AttributeType::FLOAT4,offsetof(GpuVertex,frame),sizeof(GpuVertex)).build(engine);
    if(!vb)return {};
    auto* ib=f::IndexBuffer::Builder().indexCount(static_cast<std::uint32_t>(indices->size()))
        .bufferType(f::IndexBuffer::IndexType::UINT).build(engine);
    if(!ib){engine.destroy(vb);return {};}
    auto* v=vertices.release();auto* i=indices.release();
    vb->setBufferAt(engine,0,f::VertexBuffer::BufferDescriptor(v->data(),v->size()*sizeof(GpuVertex),release_vector<GpuVertex>,v));
    ib->setBuffer(engine,f::IndexBuffer::BufferDescriptor(i->data(),i->size()*sizeof(std::uint32_t),release_vector<std::uint32_t>,i));
    return {vb,ib};
}
bool direction(Vec3 v) {
    const double n=std::hypot(v.x,v.y,v.z);
    return std::isfinite(n)&&n>1e-7&&n<1e10;
}
void paint(f::MaterialInstance& instance,const Material& mtl){
    const auto& c=mtl.linear_rgb;
    instance.setParameter("linearColor",m::float3{c[0],c[1],c[2]});
    instance.setParameter("roughness",mtl.roughness);
    instance.setParameter("metalness",mtl.metallic);
}
}
struct Graphics::Impl {
    f::Engine& engine;
    f::Scene* scene{}; f::View* view{}; f::Renderer* renderer{}; f::Camera* camera{};
    f::Material* surface{}; utils::Entity eye{},sun{};
    std::map<GeometryKey,Geometry> geometry;
    std::map<std::pair<ItemGroup,EntityId>,Item> items;
    std::uint64_t generation{};
    FrameClock presentation;
    AdaptiveQuality governor;
    std::optional<FrameQuality> requested;
    SceneFrameStats last_stats{};
    std::optional<Detail> prior_detail;
    bool memory_constrained{};
    bool trim_scene{};
    std::shared_ptr<const PublishedArt> art;
#ifdef MUNDO_OWNER_VEHICLE_ART
    OwnerVehicleArt owner_art;
#endif
    using Clock=FrameClock::Clock;
    std::optional<Clock::time_point> last_presented,next_pressure,next_gpu,got_gpu,got_period;
    DevicePressure pressure{};
    double cpu_ms{},gpu_ms{},present_hz{};
    std::uint32_t max_2d{};
    std::uint64_t estimated_budget{};
    std::int64_t gpu_sample{},period_sample{};
    explicit Impl(f::Engine& e):engine(e){}
    void remove(Item& item){
        scene->remove(item.entity);engine.destroy(item.entity);
        utils::EntityManager::get().destroy(item.entity);
        for(auto* material:item.materials)engine.destroy(material);
    }
    void clear_geometry(){
        for(auto& [id,item]:items)remove(item);
        items.clear();
        for(auto& [key,g]:geometry){engine.destroy(g.vertices);engine.destroy(g.indices);}
        geometry.clear();
    }
    ~Impl(){
        clear_geometry();
        if(view)engine.destroy(view);
        if(scene)engine.destroy(scene);
        if(sun){engine.destroy(sun);utils::EntityManager::get().destroy(sun);}
        if(eye){if(camera)engine.destroyCameraComponent(eye);utils::EntityManager::get().destroy(eye);}
        if(renderer)engine.destroy(renderer);
        if(surface)engine.destroy(surface);
    }
    bool start(std::span<const std::byte> pkg){
        art=PublishedArt::builtin_blocks();
        if(!art)return false;
        max_2d=static_cast<std::uint32_t>(f::Texture::getMaxTextureSize(engine,f::Texture::Sampler::SAMPLER_2D));
        renderer=engine.createRenderer();view=engine.createView();scene=engine.createScene();
        eye=utils::EntityManager::get().create();camera=engine.createCamera(eye);
        surface=f::Material::Builder().package(pkg.data(),pkg.size()).build(engine);
        if(!renderer||!view||!scene||!camera||!surface)return false;
        sun=utils::EntityManager::get().create();
        const auto light=f::LightManager::Builder(f::LightManager::Type::SUN).direction({-.45f,-.87f,-.21f})
            .color({1.f,.95f,.86f}).intensity(100000.f).castShadows(true).build(engine,sun);
        if(light!=f::LightManager::Builder::Success)return false;
        scene->addEntity(sun);view->setScene(scene);view->setCamera(camera);
        auto clear=renderer->getClearOptions();clear.clear=true;clear.clearColor={.12f,.16f,.20f,1.f};renderer->setClearOptions(clear);
        return true;
    }
    bool sync(std::vector<DrawItem>& list,std::size_t world_items,std::size_t peer_begin,const CameraProjection& projection,
              const FrameQuality& quality,SceneFrameStats& stats,const VehicleSession* vehicles){
        ++generation;
        auto& tm=engine.getTransformManager();
        stats.candidates=static_cast<std::uint32_t>(list.size());
        for(std::size_t index=0;index<list.size();++index){
            auto& d=list[index];
            [[maybe_unused]] const VisualKey workshop_slot=vehicles && index<world_items?vehicles->prepare_draw(d):0;
            const auto group=index<world_items?ItemGroup::world:
                (index<peer_begin?ItemGroup::local_avatar:ItemGroup::peer_avatar);
            const auto identity=std::pair{group,d.id};
            const auto coverage=projection.measure(d);
            if(!coverage.in_view && !quality.video.shadows){++stats.culled;continue;}
            auto found=items.find(identity);
            std::optional<Detail> previous;
            if(found!=items.end())previous=found->second.mesh_detail;
            const auto tier=object_detail(coverage.diameter_pixels,quality.detail,previous);
            const unsigned sides=tier==Detail::ultra?64u:tier==Detail::economy?12u:32u;
            const auto* authored=art&&d.visual?art->find(d.visual,tier):nullptr;
            bool custom=false,tint_from_node=false;
#ifdef MUNDO_OWNER_VEHICLE_ART
            if(const auto* mesh=owner_art.find(workshop_slot,tier)){
                authored=mesh;custom=true;tint_from_node=!OwnerVehicleArt::is_bruma(workshop_slot);
            }
#endif
            if(!authored&&d.shape==Shape::empty)continue;
            if(coverage.in_view)++stats.in_view;
            else ++stats.retained_for_shadows;
            ++stats.mesh_levels[static_cast<unsigned>(tier)];
            const GeometryKey key=authored?GeometryKey{custom?workshop_slot:d.visual,Shape::empty,static_cast<unsigned>(tier),custom}:
                GeometryKey{0,d.shape,d.shape==Shape::box?6u:sides,false};
            if(found!=items.end()&&found->second.geometry!=key){
                remove(found->second);items.erase(found);found=items.end();
            }
            if(found==items.end()){
                if(!geometry.contains(key)){
                    auto g=authored?upload(engine,authored->mesh):upload(engine,primitive(d.shape,std::get<2>(key)));
                    if(!g.vertices)return false;
                    geometry.emplace(key,g);
                }
                const auto g=geometry.at(key);
                Item item;
                item.entity=utils::EntityManager::get().create();item.geometry=key;
                const std::size_t count=authored?authored->sections.size():1;
                f::RenderableManager::Builder builder(count);
                builder.boundingBox({{0,0,0},{.5f,.5f,.5f}}).castShadows(true).receiveShadows(true);
                for(std::size_t slot=0;slot<count;++slot){
                    auto* material=surface->createInstance();
                    if(!material){remove(item);return false;}
                    item.materials.push_back(material);
                    if(authored){
                        const auto& s=authored->sections[slot];
                        builder.geometry(slot,f::RenderableManager::PrimitiveType::TRIANGLES,g.vertices,g.indices,s.first,s.count);
                        if(!tint_from_node)paint(*material,s.material);
                    }else builder.geometry(slot,f::RenderableManager::PrimitiveType::TRIANGLES,g.vertices,g.indices);
                    builder.material(slot,material);
                }
                const auto result=builder.build(engine,item.entity);
                if(result!=f::RenderableManager::Builder::Success){remove(item);return false;}
                scene->addEntity(item.entity);found=items.emplace(identity,item).first;
            }
            auto& item=found->second;
            item.mesh_detail=tier;
            item.last_seen=generation;
            geometry.at(key).last_seen=generation;
            if(item.applied_transform!=d.model){
                m::mat4f matrix;
                for(unsigned col=0;col<4;col++)for(unsigned row=0;row<4;row++)matrix[col][row]=d.model[col*4+row];
                if(!tm.hasComponent(item.entity))tm.create(item.entity);
                tm.setTransform(tm.getInstance(item.entity),matrix);
                item.applied_transform=d.model;
            }
#ifdef MUNDO_OWNER_VEHICLE_ART
            if(tint_from_node&&item.applied_material!=d.material){
                for(std::size_t slot=0;slot<item.materials.size();++slot)
                    paint(*item.materials[slot],OwnerVehicleArt::tinted(authored->sections[slot].material,d.material));
                item.applied_material=d.material;
            }
#endif
            if(!authored&&item.applied_material!=d.material){
                paint(*item.materials.front(),d.material);
                item.applied_material=d.material;
            }
        }
        for(auto i=items.begin();i!=items.end();){
            if(i->second.last_seen!=generation){remove(i->second);i=items.erase(i);}else ++i;
        }
        const auto grace=trim_scene||memory_constrained||(prior_detail&&*prior_detail!=quality.detail)?0u:45u;
        for(auto it=geometry.begin();it!=geometry.end();){
            if(generation-it->second.last_seen<=grace){++it;continue;}
            engine.destroy(it->second.vertices);engine.destroy(it->second.indices);
            it=geometry.erase(it);
        }
        prior_detail=quality.detail;
        trim_scene=false;
        return true;
    }
    std::optional<FrameQuality> plan(DisplayCaps caps,const VideoSettings& prefs,Clock::time_point now){
        if(!next_pressure||now>=*next_pressure){
            pressure=platform_pressure();estimated_budget=estimated_target_budget();next_pressure=now+std::chrono::seconds(2);
        }
        caps.max_target_width=caps.max_target_width?std::min(caps.max_target_width,max_2d):max_2d;
        caps.max_target_height=caps.max_target_height?std::min(caps.max_target_height,max_2d):max_2d;
        if(!caps.frame_target_budget)caps.frame_target_budget=estimated_budget;
        caps.pressure.thermal=std::max(caps.pressure.thermal,pressure.thermal);
        caps.pressure.low_power|=pressure.low_power;
        caps.memory_pressure|=caps.pressure.memory_pressure||pressure.memory_pressure;
        memory_constrained=caps.memory_pressure||caps.pressure.thermal>=ThermalPressure::serious;
        if(!next_gpu||now>=*next_gpu){
            next_gpu=now+std::chrono::milliseconds(180);
            const auto history=std::min<std::size_t>(8,renderer->getMaxFrameHistorySize());
            for(const auto& info:renderer->getFrameInfoHistory(history)){
                if(info.beginFrame>period_sample&&info.displayPresentInterval>=1'000'000&&info.displayPresentInterval<=100'000'000){
                    period_sample=info.beginFrame;present_hz=1e9/double(info.displayPresentInterval);got_period=now;
                }
                if(info.beginFrame<=gpu_sample||info.gpuFrameDuration<=0)continue;
                gpu_sample=info.beginFrame;got_gpu=now;
                auto ns=info.denoisedGpuFrameDuration>0?info.denoisedGpuFrameDuration:info.gpuFrameDuration;
                gpu_ms=double(ns)/1'000'000.;
            }
        }
        const auto cadence=last_presented?std::chrono::duration<double,std::milli>(now-*last_presented).count():0.;
        if(caps.refresh_hz<=0&&got_period&&now-*got_period<std::chrono::seconds(1))caps.refresh_hz=present_hz;
        const bool recent=got_gpu&&now-*got_gpu<std::chrono::seconds(1);
        return governor.choose(caps,prefs,{recent?gpu_ms:0.,cpu_ms,cadence},now);
    }
};
Graphics::Graphics(std::unique_ptr<Impl> p):impl_(std::move(p)){}
Graphics::~Graphics()=default;
#ifdef MUNDO_OWNER_VEHICLE_ART
bool Graphics::load_owner_vehicle_art(std::span<const std::byte> bundled,std::span<const std::byte> bruma){
    return impl_->owner_art.load(bundled,bruma);
}
void Graphics::show_owner_vehicle_art(bool enabled){impl_->owner_art.show(enabled);}
#endif
bool Graphics::install_art(std::shared_ptr<const PublishedArt> release){
    if(!release||(impl_->art&&impl_->art->revision()>=release->revision()))return false;
    impl_->clear_geometry();impl_->art=std::move(release);return true;
}
void Graphics::discard_scene(){
    impl_->clear_geometry();
    impl_->last_stats={};
}
void Graphics::trim_on_next_scene(){impl_->trim_scene=true;}
bool Graphics::memory_constrained() const{return impl_->memory_constrained;}
std::optional<FrameQuality> Graphics::requested_quality() const{return impl_->requested;}
SceneFrameStats Graphics::last_scene_stats() const{return impl_->last_stats;}
std::unique_ptr<Graphics> Graphics::create(f::Engine& e,std::span<const std::byte> pkg){
    if(pkg.empty()||pkg.size()>32*1024*1024)return {};
    auto impl=std::make_unique<Impl>(e);
    if(!impl->start(pkg))return {};
    return std::unique_ptr<Graphics>(new Graphics(std::move(impl)));
}
bool Graphics::frame(f::SwapChain& swap,const World& world,const CameraPose& cam,const DisplayCaps& caps,const VideoSettings& prefs){
    return frame(swap,world,cam,caps,prefs,nullptr);
}
bool Graphics::frame(f::SwapChain& swap,const World& world,const CameraPose& cam,const DisplayCaps& caps,const VideoSettings& prefs,const BlockAvatar* actor,const VehicleSession* vehicles){
    return draw_frame(swap,world,cam,caps,prefs,actor,vehicles,nullptr);
}
bool Graphics::frame_with_peer(f::SwapChain& swap,const World& world,const CameraPose& cam,const DisplayCaps& caps,
                               const VideoSettings& prefs,const BlockAvatar* local,const BlockAvatar* peer,
                               const VehicleSession* vehicles,std::span<const BlockAvatar* const> npcs){
    return draw_frame(swap,world,cam,caps,prefs,local,vehicles,peer,npcs);
}
bool Graphics::draw_frame(f::SwapChain& swap,const World& world,const CameraPose& cam,const DisplayCaps& caps,
                          const VideoSettings& prefs,const BlockAvatar* actor,const VehicleSession* vehicles,
                          const BlockAvatar* peer,std::span<const BlockAvatar* const> npcs){
    if(!std::isfinite(cam.eye.x)||!std::isfinite(cam.eye.y)||!std::isfinite(cam.eye.z)||
        !direction(cam.forward)||!direction(cam.up)||!(cam.near_plane>0&&cam.far_plane>cam.near_plane&&cam.far_plane<=1e12)||
        !(cam.vertical_fov>=5&&cam.vertical_fov<=160))return false;
    m::double3 look{cam.forward.x,cam.forward.y,cam.forward.z},up{cam.up.x,cam.up.y,cam.up.z};
    if(length(cross(normalize(look),normalize(up)))<.0001)return false;
    auto& g=*impl_;
    const auto start=FrameClock::Clock::now();
    if(!g.presentation.allow_present(start,prefs.fps_cap))return false;
    g.requested=g.plan(caps,prefs,start);
    if(!g.requested)return false;
    const auto* p=&g.requested->video;
    g.view->setViewport({0,0,p->surface_width,p->surface_height});
    f::DynamicResolutionOptions drs{};
    const m::float2 scale{float(p->render_width)/p->surface_width,float(p->render_height)/p->surface_height};
    drs.enabled=scale.x<.99999f||scale.y<.99999f;drs.minScale=drs.maxScale=scale;drs.homogeneousScaling=true;
    g.view->setDynamicResolutionOptions(drs);g.view->setShadowingEnabled(p->shadows);
    g.camera->setProjection(cam.vertical_fov,double(p->surface_width)/p->surface_height,cam.near_plane,cam.far_plane);
    g.camera->lookAt({0,0,0},look,up);
    const auto projection=CameraProjection::from(cam,double(p->surface_width)/p->surface_height,p->render_height);
    if(!projection)return false;
    SceneFrameStats stats;
    auto visible=world.visible(cam.eye,projection->search_distance());
    const auto world_items=visible.size();
    if(actor)actor->append(visible,cam.eye);
    const auto peer_begin=visible.size();
    if(peer)peer->append(visible,cam.eye,AvatarStyle::peer);
    for(std::size_t slot=0;slot<npcs.size();++slot){
        if(!npcs[slot])continue;
        const auto begin=visible.size();
        npcs[slot]->append(visible,cam.eye,AvatarStyle::npc);
        // The cache already separates peer and world items. Reserve distinct limb IDs for each NPC.
        for(auto i=begin;i<visible.size();++i)visible[i].id+=64*(slot+1);
    }
    if(!g.sync(visible,world_items,peer_begin,*projection,*g.requested,stats,vehicles))return false;
    const auto prepared=FrameClock::Clock::now();
    if(!g.renderer->beginFrame(&swap))return false;
    const auto encode_begin=FrameClock::Clock::now();
    g.renderer->render(g.view);
    const auto encoded=FrameClock::Clock::now();
    g.renderer->endFrame();
    g.last_stats=stats;
    g.last_presented=start;
    g.cpu_ms=std::chrono::duration<double,std::milli>((prepared-start)+(encoded-encode_begin)).count();
    return true;
}
} // namespace mundo

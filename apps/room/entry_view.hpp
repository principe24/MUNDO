#pragma once
#include "room_client.hpp"
#include "mundo/surface.hpp"
#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

namespace mundo::room {
// A loading view never installs a controllable character, vehicle or authoritative world.
class EntryView {
public:
    void accept(Update& update, Surface* surface) {
        if (!update.entry_visible || (update.phase != Phase::joining && update.phase != Phase::reconnecting)) {
            clear(surface);
            return;
        }
        if (!update.entry) return;
        auto& source = *update.entry;
        clear(surface);
        if (source.terrain.empty()) return;
        double x = source.focus_x, z = source.focus_z;
        const double span = std::numeric_limits<double>::max();
        double top = -span;
        auto find_support = [&] {
            source.terrain.visit({{x-.25,-span,z-.25},{x+.25,span,z+.25}},
                [&](const CollisionBounds& solid){top=std::max(top,solid.high[1]);});
        };
        find_support();
        if(top==-span){
            // An arrival over empty space can still show the nearest included piece of terrain.
            double nearest=span;
            source.terrain.visit({{-span,-span,-span},{span,span,span}},[&](const CollisionBounds& solid){
                const auto sx=std::clamp(source.focus_x,solid.low[0],solid.high[0]);
                const auto sz=std::clamp(source.focus_z,solid.low[2],solid.high[2]);
                const auto distance=std::hypot(sx-source.focus_x,sz-source.focus_z);
                if(distance<nearest){nearest=distance;x=sx;z=sz;}
            });
            find_support();
        }
        if(top==-span)return;
        // Prefer a clear three-quarter view. A vertical view keeps the focus visible in tight courtyards.
        camera_={};
        camera_.eye={x,top+7.,z};
        camera_.forward={0.,-1.,0.};
        camera_.up={0.,0.,-1.};
        constexpr double offsets[][2]={{4.,6.},{-4.,6.},{-4.,-6.},{4.,-6.}};
        for(const auto& offset:offsets){
            const auto ex=x+offset[0], ez=z+offset[1];
            bool blocked=false;
            source.terrain.visit({{std::min(x,ex)-.2,top+.25,std::min(z,ez)-.2},
                                  {std::max(x,ex)+.2,top+5.25,std::max(z,ez)+.2}},
                                 [&](const CollisionBounds&){blocked=true;});
            if(blocked)continue;
            camera_.eye={ex,top+5.,ez};
            const auto distance=std::hypot(offset[0],5.,offset[1]);
            camera_.forward={-offset[0]/distance,-5./distance,-offset[1]/distance};
            camera_.up={0.,1.,0.};
            break;
        }
        world_ = std::move(source.world);
    }

    void clear(Surface* surface) {
        if(touched_surface_ && surface)surface->discard_scene();
        world_.reset();
        touched_surface_ = presented_ = false;
    }
    [[nodiscard]] bool presented() const { return presented_; }
    bool draw(Surface& surface, const DisplayCaps& caps) {
        if (!world_) return false;
        touched_surface_=true;
        if (surface.frame(*world_, camera_, caps)) presented_ = true;
        return presented_;
    }

private:
    std::optional<World> world_;
    CameraPose camera_{};
    bool touched_surface_{}, presented_{};
};
}

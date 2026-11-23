#include "mundo/audio.hpp"
#include "mundo/document_digest.hpp"
#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <stdexcept>
#include <vector>

using namespace mundo;
using namespace mundo::audio;
namespace {
void check(bool value, const char* message) {
    if (!value) throw std::runtime_error(message);
}
std::string marker(std::string_view preset="brisa") {
    return std::string("MUNDO/Audio/v1/")+std::string(preset)+"/1200/650/Río / Norte";
}
EntityId add(World& w, std::string name, Vec3 position={}, EntityId parent=0) {
    auto id=w.create(std::move(name),parent);
    check(id!=0,"could not create test marker");
    auto n=*w.get(id); n.local.position=position;
    check(w.edit(n),"could not place test marker");
    return id;
}
void format() {
    World w;
    check(read_scene(w)->count==0,"empty world");
    add(w,"MUNDO/Audio/v3/agua/1200/400/Lago");
    check(read_scene(w)->count==0,"future namespace");
    const auto id=add(w,marker(),{3,2,-1});
    auto scene=read_scene(w);
    check(scene && scene->count==1 && scene->sources[0].id==id && scene->sources[0].position.x==3 &&
          scene->sources[0].radius==12 && scene->sources[0].volume==.65,"public marker read");
    auto persisted=decode(encode(w));
    check(persisted && read_scene(*persisted)->sources[0].id==id,"native round trip");
    add(w,"Hija",{},id);
    check(!read_scene(w),"children rejected");
    for(const auto* suffix:{"aire/50/0/A","agua/050/2/A","agua/50/01/A","agua/49/2/A","agua/25601/9/A",
                            "agua/50/1001/A","agua/50//A","brisa/50/0/A ","maquina/50/1/\u202fS",
                            "maquina/50/1","agua/50/1/","agua/50/1/012345678901234567890123456789012"}){
        World bad;add(bad,std::string("MUNDO/Audio/v1/")+suffix);
        check(!read_scene(bad),"malformed marker accepted");
    }
    World many;
    for(std::size_t i=0;i<max_sources;++i)add(many,marker());
    check(read_scene(many)->count==max_sources,"max source count");
    add(many,marker());
    check(!read_scene(many),"over-limit source count");
    World bad;auto child=add(bad,"Parent");add(bad,marker(),{},child);
    check(!read_scene(bad),"nested marker");
    World misplaced;add(misplaced,marker(),{1.1e6,0,0});
    check(!read_scene(misplaced),"out-of-range position");
}
double energy(const std::vector<float>& pcm,std::size_t channel,std::size_t after=0) {
    double result=0;
    for(auto i=2*after+channel;i<pcm.size();i+=2)result+=double(pcm[i])*pcm[i];
    return result;
}
void signals() {
    for(const auto* preset:{"agua","brisa","maquina"}) {
        World w;add(w,marker(preset),{1,0,0});
        Mixer whole(48000),blocks(48000);
        check(whole.set_world(w)&&blocks.set_world(w),"install signal world");
        std::vector<float> a(16384),b(a.size());
        whole.render(a);
        for(size_t i=0;i<b.size();i+=128){
            check(blocks.set_world(w),"republish same source");
            blocks.render(std::span(b).subspan(i,128));
        }
        check(a==b,"stable source phases and block-size independence");
        check(energy(a,1)>1e-6 && energy(a,0)==0,"pan to the right");
        whole.set_listener({},3.141592653589793);
        whole.render(a);
        check(energy(a,0,1024)>1e-6 && energy(a,1,1024)<1e-9,"rotated listener");
        whole.set_listener({-14,0,0},0);whole.render(a);
        check(energy(a,0,1024)+energy(a,1,1024)==0,"beyond radius");
        whole.set_listener({},0);whole.set_paused(true);whole.render(a);
        check(std::all_of(a.begin(),a.end(),[](float x){return x==0;}),"paused output");
        whole.set_paused(false);whole.render(a);check(energy(a,1)>0,"resumed output");
        whole.set_volume(0);whole.render(a);
        check(energy(a,0,1024)+energy(a,1,1024)==0,"mute");
        whole.reset();whole.render(a);check(!whole.has_sources() && energy(a,0)+energy(a,1)==0,"reset silences");
    }
    Scene crowded;
    for(std::size_t i=0;i<max_sources;i++)crowded.sources[crowded.count++]={i+1,Preset::maquina,{},12,1};
    Mixer m(48000);check(m.set_scene(crowded),"full mix");
    std::vector<float> mix(96001);m.render(mix);
    check(mix.back()==0 && energy(mix,0)>0,"odd samples");
    check(std::all_of(mix.begin(),mix.end(),[](float x){return std::isfinite(x)&&std::abs(x)<=1;}),"limited signal");
    crowded.sources[0].radius=std::numeric_limits<double>::quiet_NaN();
    check(!m.set_scene(crowded) && !m.has_sources(),"invalid replacement drops old sound");
}
void source_pause() {
    World w;
    auto a=add(w,marker("maquina"),{1,0,0});
    auto b=add(w,marker("agua"),{-1,0,0});
    Mixer mix, baseline;
    check(mix.set_world(w)&&baseline.set_world(w),"pause scene");
    std::vector<float> reference(12288), block(4096);
    baseline.render(reference);mix.render(block);
    check(std::equal(block.begin(),block.end(),reference.begin()),"two-voice reference");
    check(mix.set_source_paused(a,true)&&!mix.set_source_paused(a+b,true),"pause known source");
    check(mix.set_world(w),"refresh paused scene");
    mix.render(block);
    for(std::size_t i=0;i<block.size();i+=2)check(block[i]==reference[4096+i] && block[i+1]==0,"independent pause");
    check(mix.set_source_paused(a,false),"resume voice");mix.render(block);
    for(std::size_t i=0;i<block.size();i+=2)
        check(block[i]==reference[8192+i] && block[i+1]==reference[4096+i+1],"forgot oscillator cursor/other voice");
}

void gain_automation() {
    World world;
    add(world,"MUNDO/Audio/v2/maquina/100/1000/2d/100/loop/musica/Fondo");
    Mixer whole(8000), blocks(8000), reference(8000);
    check(whole.set_world(world)&&blocks.set_world(world)&&reference.set_world(world),"automation scene");
    whole.set_volume(0); blocks.set_volume(0);
    check(whole.fade_volume(1,100)&&blocks.fade_volume(1,100),"master fade accepted");
    std::vector<float> a(2400),b(a.size()),raw(a.size()),paused(320);
    whole.render(a);
    for(std::size_t i=0;i<b.size();i+=80) blocks.render(std::span(b).subspan(i,80));
    reference.render(raw);
    check(a==b,"master automation depends on render block size");
    for(std::size_t frame : {80u,240u,640u,799u,900u}) {
        const auto i=2*frame;
        if(std::abs(raw[i])>.00001) {
            const auto expected=std::min(1.,double(frame)/800.);
            check(std::abs(a[i]/raw[i]-expected)<.00001,"master automation curve");
        }
    }
    Mixer group(8000), direct(8000);
    check(group.set_world(world)&&direct.set_world(world),"group automation scene");
    group.set_group_volume(Group::musica,0);direct.set_group_volume(Group::musica,0);
    check(group.fade_group_volume(Group::musica,1,100),"group fade accepted");
    group.set_paused(true);group.render(paused);group.set_paused(false);
    std::vector<float> resumed(400),expected(400);
    group.render(resumed);direct.fade_group_volume(Group::musica,1,100);direct.render(expected);
    check(resumed==expected,"pause advanced group automation");
    check(!group.fade_volume(-1,10)&&!group.fade_volume(1,60001),"invalid master fade accepted");
    check(!group.fade_group_volume(static_cast<Group>(9),1,10)&&
          !group.fade_group_volume(Group::musica,2,10),"invalid group fade accepted");
}

void extended_signals() {
    World world;
    auto id=add(world,"MUNDO/Audio/v2/maquina/50/1000/2d/400/once/efectos/Alarma",{999999,0,0});
    Mixer m(8000); check(m.set_world(world),"install extended marker");
    std::vector<float> pcm(16000); m.render(pcm);
    check(energy(pcm,0)>1 && energy(pcm,0)==energy(pcm,1),"2D signal centered at long distance");
    check(energy(pcm,0,3000)==0,"pitched one-shot length");
    check(m.set_world(world),"refresh finished source");m.render(pcm);
    check(energy(pcm,0)==0 && m.trigger(id),"one-shot waits for trigger");
    m.set_group_volume(Group::efectos,0);m.render(pcm);
    check(energy(pcm,0)==0 && m.trigger(id),"effects mute");
    m.set_group_volume(Group::efectos,1);m.render(pcm);
    check(energy(pcm,0)>1,"trigger after unmute");
    check(!m.trigger(id+1),"no phantom trigger");
    check(m.set_source_paused(id,true) && m.trigger(id),"rearm paused one-shot");
    m.render(pcm); check(energy(pcm,0)==0,"retrigger unexpectedly resumed a voice");
    check(m.set_source_paused(id,false),"resume rearmed voice"); m.render(pcm);
    check(energy(pcm,0)>1,"rearmed source lost its cursor");
    check(m.set_source_paused(id,true),"pause before replacement");
    auto replacement=*read_scene(world); replacement.sources[0].preset=Preset::brisa;
    check(m.set_scene(replacement),"replace source with reused ID");
    m.render(pcm); check(energy(pcm,0)>0,"new preset inherited prior pause");
    for(const auto* suffix:{"s0123456789abcdeG0/100/1/2d/100/once/musica/A","brisa/100/1/3d/200/once/music/A",
             "brisa/100/1/3d/200/end/ambiente/A","agua/100/1000/4d/250/loop/efectos/A",
             "maquina/100/10/2d/024/once/ambiente/A","maquina/100/10/2d/401/once/efectos/A"}) {
        World bad;add(bad,std::string("MUNDO/Audio/v2/")+suffix);
        check(!read_scene(bad),"malformed extended marker accepted");
    }
}

void clip_formats() {
    // Minimal canonical file with both signed PCM extremes.
    const std::vector<std::uint8_t> wav{'R','I','F','F',40,0,0,0,'W','A','V','E','f','m','t',' ',
        16,0,0,0,1,0,1,0,0xc0,0x5d,0,0,0x80,0xbb,0,0,2,0,16,0,'d','a','t','a',4,0,0,0,0,128,255,127};
    const auto key=[](const auto& bytes){return "s"+document_digest(std::as_bytes(std::span(bytes))).substr(0,16);};
    auto decoded=decode_clip(key(wav),wav);
    check(decoded && decoded->samples().size()==2 && decoded->samples()[0]==-1 && decoded->samples()[1]==32767.f/32768,"canonical signed PCM");
    check(!decode_clip("s0000000000000000",wav) && !decode_clip("s!000000000000000",wav),"clip key mismatch");
    for (std::size_t i=0; i<44; ++i) {
        auto bad=wav;bad[i]^=1;
        check(!decode_clip(key(bad),bad),"invalid WAV header accepted");
    }
    auto bad=wav;bad.pop_back();check(!decode_clip(key(bad),bad),"odd length WAV");
    World clipworld;auto id=add(clipworld,"MUNDO/Audio/v2/"+key(wav)+"/100/1000/2d/100/once/musica/Nota");
    Mixer m(48000);check(m.set_world(clipworld),"clip world");
    std::vector<float> pcm(32);m.render(pcm);
    check(energy(pcm,0)==0,"unavailable clip");
    check(!m.set_clip("s0000000000000000",decoded),"install mismatched identity");
    check(m.set_clip(key(wav),decoded),"install late clip");
    m.render(pcm);check(energy(pcm,0)>0 && energy(pcm,0,4)==0,"exact clip one-shot");
    m.clear_clips();check(m.trigger(id),"retrigger after clearing");m.render(pcm);
    check(energy(pcm,0)==0,"old clip clearance");
    check(m.set_clip(key(wav),decoded),"reinstall");
    m.reset();check(m.set_world(clipworld),"clip world after reset");m.render(pcm);
    check(energy(pcm,0)==0,"reset releases clips");
}

void segmented_music() {
    const auto wav=[](std::int16_t a,std::int16_t b){
        std::vector<std::uint8_t> bytes{'R','I','F','F',40,0,0,0,'W','A','V','E','f','m','t',' ',
            16,0,0,0,1,0,1,0,0xc0,0x5d,0,0,0x80,0xbb,0,0,2,0,16,0,'d','a','t','a',4,0,0,0};
        bytes.push_back(static_cast<std::uint8_t>(a));bytes.push_back(static_cast<std::uint8_t>(a>>8));
        bytes.push_back(static_cast<std::uint8_t>(b));bytes.push_back(static_cast<std::uint8_t>(b>>8));
        return bytes;
    };
    const auto decode=[](const auto& bytes){
        const auto key="s"+document_digest(std::as_bytes(std::span(bytes))).substr(0,16);
        return decode_clip(key,bytes);
    };
    auto positive=decode(wav(32767,32767)),negative=decode(wav(-32768,-32768)),tail=decode(wav(16384,16384));
    check(positive&&negative&&tail,"stream fixtures");
    Mixer mixer(24000);
    check(!mixer.begin_music_stream(0,4)&&mixer.begin_music_stream(91,4),"stream identity");
    check(mixer.queue_music_segment(91,4,positive,false)&&mixer.queue_music_segment(91,5,negative,false),"initial stream window");
    check(mixer.buffered_music_segments()==2&&!mixer.queue_music_segment(91,6,tail,true),"stream memory window");
    std::vector<float> first(8);mixer.render(first);
    check(first[0]>0&&first[2]>0&&first[4]<0&&first[6]<0,"gapless segment boundary");
    check(mixer.buffered_music_segments()==1&&mixer.queue_music_segment(91,6,tail,true),"refill stream window");
    check(!mixer.queue_music_segment(91,7,tail,false),"sealed stream accepted trailing data");
    std::vector<float> last(8);mixer.render(last);
    check(last[0]>0&&last[2]>0&&last[4]==0&&!mixer.has_music_stream()&&mixer.buffered_music_segments()==0,
          "final stream segment");
    check(mixer.begin_music_stream(92)&&mixer.queue_music_segment(92,0,positive,false),"restart stream");
    check(!mixer.cancel_music_stream(91)&&mixer.cancel_music_stream(92)&&!mixer.has_music_stream(),"stale cancellation");
    check(mixer.begin_music_stream(93),"stream before reset");mixer.reset();
    check(!mixer.has_music_stream(),"world reset retained long music");
}

int transfer(int argc,char** argv) {
    const char* input=argv[1], *output=argv[2];
    std::ifstream in(input,std::ios::binary);
    if(!in)throw std::runtime_error("world input unavailable");
    const std::vector<char> bytes((std::istreambuf_iterator<char>(in)),{});
    auto world=decode(std::as_bytes(std::span(bytes)));
    if(!world)throw std::runtime_error("invalid world");
    Mixer m(argc>=4 ? static_cast<unsigned>(std::stoul(argv[3])) : 48000);
    if(!m.set_world(*world))return 2;
    Clip clip;
    if(argc==6 || argc==7) {
        std::ifstream file(argv[5],std::ios::binary);
        if(!file)throw std::runtime_error("clip unavailable");
        std::vector<std::uint8_t> raw((std::istreambuf_iterator<char>(file)),{});
        clip=decode_clip(argv[4],raw);
        if(!clip || !m.set_clip(argv[4],clip))return 3;
    }
    m.set_listener({},0);m.set_volume(1);
    std::vector<float> pcm(32768*2);
    if(argc==7) {
        check(std::string_view(argv[6])=="live","unknown transfer mode");
        std::size_t cursor=0;
        auto render_to=[&](std::size_t end){
            m.render(std::span(pcm).subspan(2*cursor,2*(end-cursor))); cursor=end;
        };
        // Exercise ordinary in-session control changes during a gain ramp and mid-clip.
        auto scene=*read_scene(*world);
        check(scene.count>=2,"live fixture is incomplete");
        render_to(37);
        m.set_listener({.3,-.1,2}, .81); render_to(888);
        m.set_group_volume(Group::musica,.25); m.set_volume(.63); render_to(2801);
        m.set_paused(true); render_to(3721); m.set_paused(false);
        scene.sources[0].position={-2.,1.,0};
        scene.sources[0].playback_rate=3.4; check(m.set_scene(scene),"live scene update");
        for(std::size_t i=0;i<scene.count;++i)if(!scene.sources[i].loop)check(m.trigger(scene.sources[i].id),"live trigger");
        check(m.set_source_paused(scene.sources[0].id,true),"live pause");
        render_to(5603); m.clear_clips();
        check(m.set_scene(scene),"live refresh during source pause");
        render_to(9701); check(m.set_source_paused(scene.sources[0].id,false),"live resume");
        check(m.set_clip(argv[4],clip),"live clip reinstall"); render_to(16381);
        m.set_listener({9999,1,0},-1.3); render_to(24017);
        m.set_listener({.2,0,0},2.2); render_to(32768);
    } else m.render(pcm);
    std::ofstream out(output,std::ios::binary);
    out.write(reinterpret_cast<const char*>(pcm.data()),static_cast<std::streamsize>(pcm.size()*sizeof(float)));
    if(!out)throw std::runtime_error("PCM write failed");
    return 0;
}
}

int main(int argc,char** argv) {
    try{
        if(argc==3 || argc==4 || argc==6 || argc==7)return transfer(argc,argv);
        check(argc==1,"usage: audio_mixer [world.mworld stereo.f32]");
        format();signals();source_pause();gain_automation();extended_signals();clip_formats();segmented_music();
        std::cout<<"Native audio scene, continuity, spatial PCM, silence, and limiter passed\n";
    }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}

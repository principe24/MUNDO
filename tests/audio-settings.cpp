#include "mundo/audio_settings.hpp"

#include <fstream>
#include <iostream>
#include <random>
#include <stdexcept>

using namespace mundo;
namespace fs=std::filesystem;
namespace {
void check(bool ok,const char* message) { if(!ok)throw std::runtime_error(message); }
struct TempDirectory {
    fs::path path;
    TempDirectory() {
        std::random_device random;
        for(int i=0;i<8;++i){
            auto candidate=fs::temp_directory_path()/("mundo-audio-levels-"+std::to_string(random()));
            if(fs::create_directory(candidate)){path=std::move(candidate);return;}
        }
        throw std::runtime_error("No se pudo crear una carpeta temporal.");
    }
    ~TempDirectory(){std::error_code ignored;fs::remove_all(path,ignored);}
};
}

int main() {
    try {
        TempDirectory directory;
        DeviceAudioProfile pc(directory.path,DeviceFamily::desktop);
        const AudioLevels original{};
        check(pc.settings()==original,"Niveles iniciales.");
        AudioLevels edited{true,39,{9,20,88,0}};
        check(pc.apply(edited)==SettingsResult::saved,"Escritura de PC.");
        check(DeviceAudioProfile(directory.path,DeviceFamily::desktop).settings()==edited,"Recuperación completa.");
        DeviceAudioProfile mobile(directory.path,DeviceFamily::mobile);
        check(mobile.settings()==original,"Las preferencias móviles son independientes.");
        auto other=original;other.groups[1]=0;
        check(mobile.apply(other)==SettingsResult::saved,"Escritura móvil.");
        check(DeviceAudioProfile(directory.path,DeviceFamily::desktop).settings()==edited,"Aislamiento de plataformas.");
        auto invalid=edited;invalid.groups[3]=101;
        check(pc.apply(invalid)==SettingsResult::invalid && pc.settings()==edited,"Volumen de voces fuera de rango.");
        invalid=edited;invalid.volume=101;
        check(pc.apply(invalid)==SettingsResult::invalid,"Volumen general fuera de rango.");
        DeviceAudioProfile session({},DeviceFamily::desktop);
        check(session.apply(edited)==SettingsResult::session_only && session.settings()==edited,"Perfil efímero.");
        const auto file=directory.path/"audio-pc.v1";
        std::ofstream(file,std::ios::binary|std::ios::app).put('!');
        check(DeviceAudioProfile(directory.path,DeviceFamily::desktop).settings()==original,"Perfil corrupto.");
        fs::remove(file);
        fs::create_directory(file);
        check(pc.apply(original)==SettingsResult::write_failed && pc.settings()==edited,"Escritura fallida.");
        std::cout<<"Persistencia, límites, error recuperable y aislamiento móvil/PC verificados.\n";
    } catch(const std::exception& e) {
        std::cerr<<e.what()<<"\n";return 1;
    }
}

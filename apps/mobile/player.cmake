if(MUNDO_ANDROID_OWNER_PLAYER OR MUNDO_IOS_OWNER_PLAYER)
    set(mobile_edition owner)
else()
    set(mobile_edition public)
endif()
set(mobile_embeds "${generated_dir}/mobile-${mobile_edition}")
function(mundo_mobile_embed name input)
    add_custom_command(OUTPUT "${mobile_embeds}/mobile_${name}.inc"
        COMMAND "${CMAKE_COMMAND}" -E make_directory "${mobile_embeds}"
        COMMAND "${CMAKE_COMMAND}" "-DINPUT=${input}" "-DOUTPUT=${mobile_embeds}/mobile_${name}.inc"
            -P "${MUNDO_ROOT}/cmake/EmbedMobile.cmake"
        DEPENDS "${input}" "${MUNDO_ROOT}/cmake/EmbedMobile.cmake" VERBATIM)
endfunction()
if(mobile_edition STREQUAL "owner")
    mundo_mobile_embed(touring_art "${MUNDO_ROOT}/authoring/touring-car/vault/turismo.mlook")
    mundo_mobile_embed(bruma_art "${MUNDO_ROOT}/authoring/bruma/vault/bruma.mlook")
endif()
mundo_mobile_embed(material "${CMAKE_CURRENT_BINARY_DIR}/surface.filamat")
add_library(mundo_mobile_session STATIC apps/mobile/session.cpp apps/mobile/session_room.cpp apps/mobile/checkpoint.cpp apps/mobile/document.cpp
    "${mobile_embeds}/mobile_material.inc")
set_target_properties(mundo_mobile_session PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_include_directories(mundo_mobile_session PUBLIC apps/mobile PRIVATE "${mobile_embeds}")
target_link_libraries(mundo_mobile_session PUBLIC Mundo::Graphics mundo_room_client)
target_compile_definitions(mundo_mobile_session PUBLIC MUNDO_MOBILE_ROOMS=1 MUNDO_NATIVE_PROJECT_FILES=1)
if(mobile_edition STREQUAL "owner")
    target_sources(mundo_mobile_session PRIVATE "${mobile_embeds}/mobile_touring_art.inc" "${mobile_embeds}/mobile_bruma_art.inc")
endif()
if(MUNDO_ANDROID_OWNER_PLAYER)
    target_compile_definitions(mundo_mobile_session PUBLIC MUNDO_ANDROID_OWNER_PLAYER=1)
elseif(MUNDO_IOS_OWNER_PLAYER)
    target_compile_definitions(mundo_mobile_session PUBLIC MUNDO_IOS_OWNER_PLAYER=1)
endif()
if(ANDROID)
    target_sources(mundo_mobile_session PRIVATE apps/android/audio_device.cpp)
    target_link_libraries(mundo_mobile_session PRIVATE aaudio)
    add_library(mundo_mobile SHARED apps/android/bridge.cpp
        "${filament_dir}/android/filament-android/src/main/cpp/Filament.cpp")
    target_include_directories(mundo_mobile PRIVATE "${filament_dir}/filament/backend/include")
    target_link_libraries(mundo_mobile PRIVATE mundo_mobile_session android)
else()
    target_sources(mundo_mobile_session PRIVATE apps/ios/audio_device.cpp)
    target_link_libraries(mundo_mobile_session PRIVATE "-framework AudioToolbox")
    if(MUNDO_IOS_OWNER_PLAYER)
        set(ios_identifier "studio.mundo.player.owner")
        set(ios_executable "MUNDO_Propietario")
        set(ios_display_name "MUNDO Propietario")
    else()
        set(ios_identifier "studio.mundo.player")
        set(ios_executable "MUNDO")
        set(ios_display_name "MUNDO")
    endif()
    add_executable(mundo_ios MACOSX_BUNDLE apps/ios/player.mm apps/ios/seat_scanner.mm apps/ios/audio_preferences.mm)
    target_compile_options(mundo_ios PRIVATE -fobjc-arc)
    set_target_properties(mundo_ios PROPERTIES
        OBJCXX_STANDARD 20 OBJCXX_STANDARD_REQUIRED ON OUTPUT_NAME "${ios_executable}"
        MACOSX_BUNDLE_GUI_IDENTIFIER "${ios_identifier}"
        MACOSX_BUNDLE_BUNDLE_NAME "${ios_display_name}"
        MACOSX_BUNDLE_BUNDLE_VERSION 62
        MACOSX_BUNDLE_SHORT_VERSION_STRING "${PROJECT_VERSION}"
        MACOSX_BUNDLE_INFO_PLIST "${MUNDO_ROOT}/apps/ios/Info.plist"
        XCODE_ATTRIBUTE_PRODUCT_BUNDLE_IDENTIFIER "${ios_identifier}"
        XCODE_ATTRIBUTE_TARGETED_DEVICE_FAMILY "1,2")
    target_link_libraries(mundo_ios PRIVATE mundo_mobile_session "-framework UIKit" "-framework AVFoundation" "-framework QuartzCore" "-framework Metal")
endif()

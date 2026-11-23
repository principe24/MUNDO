#pragma once
#import <UIKit/UIKit.h>
#include "mundo/audio_settings.hpp"

UIViewController* MundoAudioPreferences(mundo::AudioLevels levels, BOOL (^save)(mundo::AudioLevels));

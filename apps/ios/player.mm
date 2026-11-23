#import <UIKit/UIKit.h>
#import <AVFoundation/AVFoundation.h>
#import "seat_scanner.h"
#import "audio_preferences.h"
#import <QuartzCore/CAMetalLayer.h>
#import <Metal/Metal.h>
#include "session.hpp"
#include <cmath>
#include <string_view>

@interface GameView : UIView
@property(nonatomic,assign) mundo::mobile::Session *game;
@end
@implementation GameView
+ (Class)layerClass {return CAMetalLayer.class;}
- (void)layoutSubviews {
    [super layoutSubviews];
    CGFloat scale=self.window.screen.nativeScale ?: self.contentScaleFactor;
    CAMetalLayer *layer=(CAMetalLayer*)self.layer;
    layer.contentsScale=scale;
    layer.drawableSize=CGSizeMake(self.bounds.size.width*scale,self.bounds.size.height*scale);
}
- (void)dispatchTouches:(NSSet<UITouch*>*)touches phase:(int)phase {
    if(!_game)return;
    for(UITouch *touch in touches){
        CGPoint point=[touch locationInView:self];
        _game->touch((intptr_t)(__bridge void*)touch,phase,point.x,point.y,self.bounds.size.width,self.bounds.size.height);
    }
}
- (void)touchesBegan:(NSSet*)t withEvent:(UIEvent*)e {[self dispatchTouches:t phase:0];}
- (void)touchesMoved:(NSSet*)t withEvent:(UIEvent*)e {[self dispatchTouches:t phase:1];}
- (void)touchesEnded:(NSSet*)t withEvent:(UIEvent*)e {[self dispatchTouches:t phase:2];}
- (void)touchesCancelled:(NSSet*)t withEvent:(UIEvent*)e {[self dispatchTouches:t phase:2];}
@end

// VoiceOver users can latch the brake with one activation and release it with the next.
@interface DrivePedal : UIButton
@property(nonatomic,copy) void (^activatePedal)(void);
@end
@implementation DrivePedal
- (BOOL)accessibilityActivate {
    if(!self.enabled || !self.activatePedal)return NO;
    self.activatePedal();
    return YES;
}
@end

@interface PlayerController : UIViewController
@end
@implementation PlayerController {
    mundo::mobile::Session _game;
    GameView *_viewport;
    CADisplayLink *_link;
    BOOL _ready;
    UIButton *_camera, *_vehicle, *_room, *_meeting;
    __weak UIAlertController *_meetingDialog;
    UILabel *_roomState,*_carGuide,*_course;
    CFTimeInterval _nextCarGuide;
    unsigned _roomRevision;
    BOOL _showingRoom,_showingFrame,_showingEntry,_viewInFront;
    UILabel *_lobby;
    DrivePedal *_pedal;
    UILabel *_speed;
    UILabel *_driveHint;
    BOOL _didShowDriveHint;
    BOOL _showingDriving;
#ifdef MUNDO_IOS_OWNER_PLAYER
    UIButton *_vehicleStyle;
#endif
    NSInteger _shownSpeed;
    CFTimeInterval _nextSpeedUpdate;
    BOOL _jumpOnRelease;
    BOOL _brakeHeld;
    NSString *_pendingNotice;

}
- (BOOL)prefersStatusBarHidden{return YES;}
- (void)didReceiveMemoryWarning {
    [super didReceiveMemoryWarning];
    _game.trim_world_cache();
    if(self.isViewLoaded)[self refreshRoomState];
}
- (UIInterfaceOrientationMask)supportedInterfaceOrientations{return UIInterfaceOrientationMaskLandscape;}
- (UIButton*)button:(NSString*)title action:(SEL)action {
    UIButton *button=[UIButton buttonWithType:UIButtonTypeSystem];[button setTitle:title forState:UIControlStateNormal];
    button.backgroundColor=UIColor.systemBackgroundColor;button.layer.cornerRadius=6;
    [button addTarget:self action:action forControlEvents:UIControlEventTouchUpInside];
    return button;
}
- (void)viewDidLoad {
    [super viewDidLoad];
    _viewport=[[GameView alloc] initWithFrame:self.view.bounds];
    _viewport.autoresizingMask=UIViewAutoresizingFlexibleWidth|UIViewAutoresizingFlexibleHeight;
    _viewport.opaque=YES; _viewport.layer.opaque=YES;
    _viewport.multipleTouchEnabled=YES;_viewport.game=&_game;
    ((CAMetalLayer*)_viewport.layer).device=MTLCreateSystemDefaultDevice();
    [self.view addSubview:_viewport];
    _viewport.accessibilityIdentifier=@"mundo.viewport";
    _lobby=[[UILabel alloc] initWithFrame:self.view.bounds];
    _lobby.autoresizingMask=UIViewAutoresizingFlexibleWidth|UIViewAutoresizingFlexibleHeight;
    _lobby.textAlignment=NSTextAlignmentCenter; _lobby.numberOfLines=3;
    _lobby.backgroundColor=[UIColor colorWithRed:.09 green:.15 blue:.16 alpha:1];
    _lobby.textColor=UIColor.whiteColor; _lobby.userInteractionEnabled=YES;
    _lobby.text=@"MUNDO en línea · Abre Sala para entrar con tu invitación.";
    [self.view addSubview:_lobby];
    _camera=[self button:@"Cámara" action:@selector(toggleCamera)];
    _vehicle=[self button:@"Carro" action:@selector(car)];
    _vehicle.accessibilityIdentifier=@"mundo.vehicle";
    _room=[self button:@"Sala" action:@selector(roomAction)];
    _room.accessibilityIdentifier=@"mundo.room";
    _room.accessibilityLabel=@"Entrar a una sala privada";
    _meeting=[self button:@"Encuentro" action:@selector(confirmMeeting)];
    _meeting.accessibilityIdentifier=@"mundo.room.meeting";
    _meeting.accessibilityLabel=@"Volver al punto de encuentro";
    _meeting.hidden=YES;
    UIStackView *bar=[[UIStackView alloc] initWithArrangedSubviews:@[_vehicle, _room, _meeting, _camera, [self button:@"Ajustes" action:@selector(chooseSettings)]]];
    bar.spacing=8;
    _pedal=[[DrivePedal alloc] initWithFrame:CGRectZero];
    _pedal.backgroundColor=UIColor.systemBackgroundColor;
    [_pedal setTitleColor:UIColor.labelColor forState:UIControlStateNormal];
    [_pedal setTitleColor:UIColor.systemBlueColor forState:UIControlStateSelected];
    _pedal.layer.cornerRadius=6;
    _pedal.accessibilityIdentifier=@"mundo.pedal";
    [_pedal addTarget:self action:@selector(pedalDown) forControlEvents:UIControlEventTouchDown];
    [_pedal addTarget:self action:@selector(pedalUp) forControlEvents:UIControlEventTouchUpInside];
    [_pedal addTarget:self action:@selector(releasePedal) forControlEvents:UIControlEventTouchUpOutside|UIControlEventTouchCancel];
    __weak PlayerController *weakSelf=self;
    _pedal.activatePedal=^{[weakSelf activateAccessiblePedal];};
    _speed=[UILabel new];
    _speed.font=[UIFont monospacedDigitSystemFontOfSize:16 weight:UIFontWeightSemibold];
    _speed.textColor=UIColor.whiteColor;
    _speed.backgroundColor=[UIColor.blackColor colorWithAlphaComponent:.72];
    _speed.textAlignment=NSTextAlignmentCenter;
    _speed.accessibilityIdentifier=@"mundo.speed";
    _speed.accessibilityLabel=@"Velocidad";
    UIStackView *pedals=[[UIStackView alloc] initWithArrangedSubviews:@[_speed,_pedal]];
    pedals.axis=UILayoutConstraintAxisVertical;
    pedals.spacing=4;
    for(UIView *v in @[bar,pedals]){v.translatesAutoresizingMaskIntoConstraints=NO;[self.view addSubview:v];}
    UILayoutGuide *safe=self.view.safeAreaLayoutGuide;
    [NSLayoutConstraint activateConstraints:@[[bar.topAnchor constraintEqualToAnchor:safe.topAnchor constant:8],
        [bar.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-10],
        [pedals.trailingAnchor constraintEqualToAnchor:safe.trailingAnchor constant:-10],
        [pedals.bottomAnchor constraintEqualToAnchor:safe.bottomAnchor constant:-8],
        [_pedal.widthAnchor constraintGreaterThanOrEqualToConstant:80],
        [_pedal.heightAnchor constraintGreaterThanOrEqualToConstant:44]]];
#ifdef MUNDO_IOS_OWNER_PLAYER
    _vehicleStyle=[self button:@"" action:@selector(toggleVehicleStyle)];
    _vehicleStyle.accessibilityIdentifier=@"mundo.vehicleStyle";
    _vehicleStyle.accessibilityLabel=@"Apariencia del turismo";
    _vehicleStyle.accessibilityHint=@"Cambia entre bloques y realismo mientras conduces.";
    _vehicleStyle.titleLabel.adjustsFontSizeToFitWidth=YES;
    [_vehicleStyle setContentCompressionResistancePriority:UILayoutPriorityDefaultLow forAxis:UILayoutConstraintAxisHorizontal];
    _vehicleStyle.translatesAutoresizingMaskIntoConstraints=NO;
    [self.view addSubview:_vehicleStyle];
    [NSLayoutConstraint activateConstraints:@[[_vehicleStyle.topAnchor constraintEqualToAnchor:bar.topAnchor],
        [_vehicleStyle.leadingAnchor constraintEqualToAnchor:safe.leadingAnchor constant:10],
        [_vehicleStyle.trailingAnchor constraintLessThanOrEqualToAnchor:bar.leadingAnchor constant:-8],
        [_vehicleStyle.heightAnchor constraintGreaterThanOrEqualToConstant:44]]];
#endif
    _driveHint=[UILabel new];
    _driveHint.text=@"Usa la mitad izquierda para acelerar y girar. Mantén Frenar para detenerte.";
    _driveHint.textColor=UIColor.whiteColor;
    _driveHint.backgroundColor=[UIColor.blackColor colorWithAlphaComponent:.72];
    _driveHint.textAlignment=NSTextAlignmentCenter;
    _driveHint.font=[UIFont preferredFontForTextStyle:UIFontTextStyleFootnote];
    _driveHint.numberOfLines=2;
    _driveHint.userInteractionEnabled=NO;
    _driveHint.isAccessibilityElement=NO;
    _driveHint.hidden=YES;
    _driveHint.translatesAutoresizingMaskIntoConstraints=NO;
    [self.view addSubview:_driveHint];
    [NSLayoutConstraint activateConstraints:@[[_driveHint.centerXAnchor constraintEqualToAnchor:safe.centerXAnchor],
        [_driveHint.bottomAnchor constraintEqualToAnchor:pedals.topAnchor constant:-8],
        [_driveHint.leadingAnchor constraintGreaterThanOrEqualToAnchor:safe.leadingAnchor constant:8],
        [_driveHint.trailingAnchor constraintLessThanOrEqualToAnchor:safe.trailingAnchor constant:-8]]];
    _roomState=[UILabel new];
    _roomState.font=[UIFont preferredFontForTextStyle:UIFontTextStyleFootnote];
    _roomState.textColor=UIColor.whiteColor;
    _roomState.backgroundColor=[UIColor.blackColor colorWithAlphaComponent:.72];
    _roomState.textAlignment=NSTextAlignmentCenter;
    _roomState.userInteractionEnabled=NO;
    _roomState.accessibilityIdentifier=@"mundo.room.status";
    _roomState.hidden=YES;
    _roomState.translatesAutoresizingMaskIntoConstraints=NO;
    [self.view addSubview:_roomState];
    [NSLayoutConstraint activateConstraints:@[
        [_roomState.topAnchor constraintEqualToAnchor:bar.bottomAnchor constant:8],
        [_roomState.centerXAnchor constraintEqualToAnchor:safe.centerXAnchor],
        [_roomState.leadingAnchor constraintGreaterThanOrEqualToAnchor:safe.leadingAnchor constant:8],
        [_roomState.trailingAnchor constraintLessThanOrEqualToAnchor:safe.trailingAnchor constant:-8]]];
    _course=[UILabel new];
    _course.font=_roomState.font;
    _course.adjustsFontForContentSizeCategory=YES;
    _course.textColor=_roomState.textColor;
    _course.backgroundColor=_roomState.backgroundColor;
    _course.textAlignment=NSTextAlignmentCenter;
    _course.numberOfLines=0;
    _course.accessibilityIdentifier=@"mundo.room.circuit";
    _course.hidden=YES;_course.translatesAutoresizingMaskIntoConstraints=NO;
    [self.view addSubview:_course];
    [NSLayoutConstraint activateConstraints:@[
        [_course.topAnchor constraintEqualToAnchor:_roomState.bottomAnchor constant:2],
        [_course.centerXAnchor constraintEqualToAnchor:safe.centerXAnchor],
        [_course.widthAnchor constraintLessThanOrEqualToAnchor:safe.widthAnchor constant:-16]]];
    _carGuide=[UILabel new];
    _carGuide.font=_roomState.font;
    _carGuide.textColor=_roomState.textColor;
    _carGuide.backgroundColor=_roomState.backgroundColor;
    _carGuide.accessibilityIdentifier=@"mundo.room.carGuide";
    _carGuide.hidden=YES;
    _carGuide.translatesAutoresizingMaskIntoConstraints=NO;
    [self.view addSubview:_carGuide];
    [NSLayoutConstraint activateConstraints:@[
        [_carGuide.topAnchor constraintEqualToAnchor:_course.bottomAnchor constant:2],
        [_carGuide.centerXAnchor constraintEqualToAnchor:safe.centerXAnchor],
        [_carGuide.widthAnchor constraintLessThanOrEqualToAnchor:safe.widthAnchor]]];
    [self updateDrivingControls];
    _roomRevision=~0u;
    [self refreshRoomState];
    AVAudioSession *sound=AVAudioSession.sharedInstance;
    [sound setCategory:AVAudioSessionCategoryAmbient error:nil];
    NSNotificationCenter *n=NSNotificationCenter.defaultCenter;
    [n addObserver:self selector:@selector(soundInterrupted:) name:AVAudioSessionInterruptionNotification object:sound];
    [n addObserver:self selector:@selector(soundServicesReset:) name:AVAudioSessionMediaServicesWereResetNotification object:sound];
    [n addObserver:self selector:@selector(willResignActive:) name:UIApplicationWillResignActiveNotification object:nil];
    [n addObserver:self selector:@selector(didBecomeActive:) name:UIApplicationDidBecomeActiveNotification object:nil];
    _game.set_room_active(false);
}
- (void)viewDidAppear:(BOOL)animated {
    [super viewDidAppear:animated];
    _viewInFront=YES;
    _game.set_room_active(UIApplication.sharedApplication.applicationState==UIApplicationStateActive);
    if(!_ready){
        [_viewport setNeedsLayout];[_viewport layoutIfNeeded];
        NSURL *dir=[NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject;
        if(dir)_ready=_game.attach((__bridge void*)_viewport.layer,mundo::GraphicsAPI::metal,
            std::filesystem::path(dir.fileSystemRepresentation)/"MUNDO"/"settings");
        if(!_ready){[self presentNotice:@"No se pudo iniciar el renderizador."];return;}
    }
    [self startFrames];
}
- (void)soundInterrupted:(NSNotification*)notification {
    const auto type=[notification.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue];
    const auto options=[notification.userInfo[AVAudioSessionInterruptionOptionKey] unsignedIntegerValue];
    dispatch_async(dispatch_get_main_queue(), ^{
        const bool mayResume = type==AVAudioSessionInterruptionTypeEnded && (options & AVAudioSessionInterruptionOptionShouldResume);
        self->_game.set_room_audio_allowed(mayResume);
    });
}
- (void)soundServicesReset:(NSNotification*)notification {
    dispatch_async(dispatch_get_main_queue(), ^{
        self->_game.set_room_audio_allowed(false);
        [AVAudioSession.sharedInstance setCategory:AVAudioSessionCategoryAmbient error:nil];
        self->_game.set_room_audio_allowed(true);
    });
}
- (void)didBecomeActive:(NSNotification*)notification {
    // A new explicit activation can resume audio after a non-resumable interruption.
    _game.set_room_audio_allowed(true);
    _game.set_room_active(_viewInFront);
    [self startFrames];
}
- (void)willResignActive:(NSNotification*)notification {
    _game.set_room_active(false);
    [self refreshRoomState];
    if(_meetingDialog.presentingViewController)[_meetingDialog dismissViewControllerAnimated:NO completion:nil];
    [self stopFrames];
}
- (void)startFrames {
    if(!_viewInFront||!_ready||_link||!self.view.window||
        UIApplication.sharedApplication.applicationState!=UIApplicationStateActive)return;
    _link=[CADisplayLink displayLinkWithTarget:self selector:@selector(draw:)];
    _link.preferredFramesPerSecond=_showingFrame?self.view.window.screen.maximumFramesPerSecond:15;
    [_link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
}
- (void)stopFrames {[_link invalidate];_link=nil;[self pauseInput];}
- (void)viewWillDisappear:(BOOL)animated {
    [super viewWillDisappear:animated];
    _viewInFront=NO;
    _game.set_room_active(false);
    [self refreshRoomState];
    [self stopFrames];
}
- (void)draw:(CADisplayLink*)link {
    if(self.presentedViewController){
        if(_showingEntry){_showingEntry=NO;_lobby.hidden=NO;_roomState.hidden=YES;}
        _game.pause();return;
    }
    if(_pendingNotice){
        NSString *message=_pendingNotice;
        _pendingNotice=nil;
        [self presentNotice:message];
        return;
    }
    double interval=link.targetTimestamp-link.timestamp;
    _game.frame(link.timestamp,interval>0?1./interval:0);
    [self refreshRoomState];
    if(_showingRoom && link.timestamp>=_nextCarGuide){
        _nextCarGuide=link.timestamp+1.;
        const auto guide=_game.room_car_guide();
        NSString *text=[NSString stringWithUTF8String:guide.c_str()];
        if(![_carGuide.text isEqualToString:text])_carGuide.text=text;
        _carGuide.hidden=!text.length;
    }
    [self updateSpeed:link.timestamp];
}
- (void)refreshRoomState {
    const unsigned revision=_game.room_status_revision();
    const BOOL active=_game.in_room();
    const BOOL playable=_game.room_ready();
    const BOOL preview=_game.entry_visible();
    if(revision==_roomRevision && active==_showingRoom && playable==_showingFrame && preview==_showingEntry)return;
    _showingFrame=playable;_showingEntry=preview;
    _lobby.hidden=playable || preview;
    if(!playable)_carGuide.hidden=YES;
    _camera.hidden=!playable;
    _link.preferredFramesPerSecond=playable?self.view.window.screen.maximumFramesPerSecond:15;
#ifdef MUNDO_IOS_OWNER_PLAYER
    _vehicleStyle.hidden=!playable || !_game.room_has_car();
#endif
    _roomRevision=revision;
    const BOOL changed=active!=_showingRoom;
    if(changed){
        _showingRoom=active;_nextCarGuide=0;
        if(!active)_carGuide.hidden=YES;
        [_room setTitle:active?@"Salir":@"Sala" forState:UIControlStateNormal];
        _room.accessibilityLabel=active?@"Salir de la sala privada":@"Entrar a una sala privada";
    }
    const BOOL driving=_game.driving();
    _meeting.hidden=_game.meeting_ticket()==0;
    _vehicle.hidden=!playable || !_game.room_has_car();
    [_vehicle setTitle:active?@"Plazas":@"Carro" forState:UIControlStateNormal];
    _vehicle.accessibilityLabel=active?@"Elegir plaza o bajar del carro":@"Carro";
    _pedal.hidden=!playable || _game.room_riding();
    if(changed || driving!=_showingDriving)[self updateDrivingControls];
    const auto caption=_game.room_course();
    NSString *lap=[[NSString alloc] initWithBytes:caption.data() length:caption.size() encoding:NSUTF8StringEncoding];
    const BOOL lapChanged=![_course.text isEqualToString:lap];
    _course.hidden=!playable || !lap.length;
    if(lapChanged){
        _course.text=lap;
        if(!_course.hidden && UIAccessibilityIsVoiceOverRunning())UIAccessibilityPostNotification(UIAccessibilityAnnouncementNotification,lap);
    }
    const auto text=_game.room_status();
    NSString *status=[[NSString alloc] initWithBytes:text.data() length:text.size() encoding:NSUTF8StringEncoding];
    if(preview)status=[@"Zona de entrada · " stringByAppendingString:(status.length?status:@"Cargando partida…")];
    const BOOL statusChanged=![_roomState.text isEqualToString:status];
    _roomState.text=status;
    _roomState.hidden=(!playable && !preview) || !status.length;
    if(!playable)_lobby.text=status.length?(active?status:[status stringByAppendingString:@" · Abre Sala para entrar."]):
        @"MUNDO en línea · Abre Sala para entrar con tu invitación.";
    if(status.length && statusChanged)UIAccessibilityPostNotification(UIAccessibilityAnnouncementNotification,status);
}
- (void)joinWithInvitation:(NSString*)link {
    if(!_ready || _game.in_room())return;
    NSData *ascii=link.length<=256?[link dataUsingEncoding:NSASCIIStringEncoding allowLossyConversion:NO]:nil;
    if(!ascii.length || !_game.join_room(std::string_view(static_cast<const char*>(ascii.bytes),ascii.length))){
        [self notice:@"Revisa el enlace de invitación de tu asiento."];
        return;
    }
    _pendingNotice=nil;
    [self refreshRoomState];
}
- (void)showSeatScanner {
    if(!_ready || _game.in_room() || self.presentedViewController)return;
    MundoSeatScanner *scanner=[MundoSeatScanner new];
    scanner.modalPresentationStyle=UIModalPresentationFullScreen;
    __weak PlayerController *weakSelf=self;
    scanner.onInvitation=^(NSString *link,NSString *origin){
        PlayerController *player=weakSelf;
        if(!player || !player.view.window || player.presentedViewController || player->_game.in_room())return;
        UIAlertController *confirm=[UIAlertController alertControllerWithTitle:@"Invitación de MUNDO"
            message:[NSString stringWithFormat:@"¿Entrar en la sala de %@?",origin] preferredStyle:UIAlertControllerStyleAlert];
        [confirm addAction:[UIAlertAction actionWithTitle:@"Cancelar" style:UIAlertActionStyleCancel handler:nil]];
        [confirm addAction:[UIAlertAction actionWithTitle:@"Entrar" style:UIAlertActionStyleDefault handler:^(UIAlertAction *action){
            [player joinWithInvitation:link];
        }]];
        [player presentViewController:confirm animated:YES completion:nil];
    };
    [self presentViewController:scanner animated:YES completion:nil];
}
- (void)confirmMeeting {
    if(!_ready || self.presentedViewController)return;
    const auto ticket=_game.meeting_ticket();
    if(!ticket)return;
    [self pauseInput];
    UIAlertController *alert=[UIAlertController alertControllerWithTitle:@"Punto de encuentro"
        message:@"¿Volver al punto de encuentro de esta sala?" preferredStyle:UIAlertControllerStyleAlert];
    alert.view.accessibilityIdentifier=@"mundo.room.confirmMeeting";
    [alert addAction:[UIAlertAction actionWithTitle:@"Cancelar" style:UIAlertActionStyleCancel handler:nil]];
    [alert addAction:[UIAlertAction actionWithTitle:@"Volver" style:UIAlertActionStyleDefault handler:^(UIAlertAction *action){
        if(UIApplication.sharedApplication.applicationState!=UIApplicationStateActive)return;
        if(!self->_game.return_to_meeting(ticket))[self notice:@"El regreso ya no está disponible."];
        [self refreshRoomState];
    }]];
    _meetingDialog=alert;
    [self presentViewController:alert animated:YES completion:nil];
}
- (void)roomAction {
    if(!_ready)return;
    [self pauseInput];
    if(_game.in_room()){
        _game.leave_room();
        [self refreshRoomState];
        return;
    }
    UIAlertController *alert=[UIAlertController alertControllerWithTitle:@"Entrar a una sala privada"
        message:@"Pega la invitación de tu asiento o escanea su código en el panel del anfitrión." preferredStyle:UIAlertControllerStyleAlert];
    [alert addTextFieldWithConfigurationHandler:^(UITextField *field){
        field.accessibilityIdentifier=@"mundo.room.invitation";
        field.accessibilityLabel=@"Invitación de la sala";
        field.placeholder=@"Enlace de invitación";
        field.keyboardType=UIKeyboardTypeURL;
        field.autocorrectionType=UITextAutocorrectionTypeNo;
        field.autocapitalizationType=UITextAutocapitalizationTypeNone;
        field.spellCheckingType=UITextSpellCheckingTypeNo;
        field.secureTextEntry=YES;
    }];
    __weak UIAlertController *weakAlert=alert;
    [alert addAction:[UIAlertAction actionWithTitle:@"Entrar" style:UIAlertActionStyleDefault handler:^(UIAlertAction *action){
        UITextField *field=weakAlert.textFields.firstObject;
        NSString *link=[field.text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
        field.text=@"";
        [self joinWithInvitation:link];
    }]];
    [alert addAction:[UIAlertAction actionWithTitle:@"Escanear QR" style:UIAlertActionStyleDefault handler:^(UIAlertAction *action){
        UIAlertController *menu=weakAlert;
        if(menu.presentingViewController){
            [menu dismissViewControllerAnimated:YES completion:^{[self showSeatScanner];}];
        }else [self showSeatScanner];
    }]];
    [alert addAction:[UIAlertAction actionWithTitle:@"Cancelar" style:UIAlertActionStyleCancel handler:nil]];
    [self presentViewController:alert animated:YES completion:nil];
}
- (void)toggleCamera {_game.toggle_camera();}
- (void)releasePedal {
    _jumpOnRelease=NO;
    _brakeHeld=NO;
    _pedal.selected=NO;
    _game.hold_brake(false);
}
- (void)setBrakeHeld:(BOOL)held {
    _brakeHeld=held;
    _pedal.selected=held;
    _game.hold_brake(held);
}
- (void)pedalDown {
    if(!_ready)return;
    if(_game.driving())[self setBrakeHeld:YES];
    else _jumpOnRelease=YES;
}
- (void)pedalUp {
    if(_jumpOnRelease && !_game.driving())_game.jump();
    [self releasePedal];
}
- (void)activateAccessiblePedal {
    if(!_ready)return;
    if(_game.driving())[self setBrakeHeld:!_brakeHeld];
    else _game.jump();
}
- (void)pauseInput {
    [_pedal cancelTrackingWithEvent:nil];
    [self releasePedal];
    _game.pause();
}
- (void)updateSpeed:(CFTimeInterval)time {
    if(_speed.hidden || time<_nextSpeedUpdate)return;
    _nextSpeedUpdate=time+.2;
    NSInteger kmh=std::lround(std::abs(_game.vehicle_speed())*3.6);
    if(kmh==_shownSpeed)return;
    _shownSpeed=kmh;
    _speed.text=[NSString stringWithFormat:@"%ld km/h",(long)kmh];
    _speed.accessibilityValue=_speed.text;
}
- (void)updateDrivingControls {
    [self releasePedal];
    BOOL driving=_game.driving();
    _showingDriving=driving;
    if(!driving)_driveHint.hidden=YES;
#ifdef MUNDO_IOS_OWNER_PLAYER
    [self updateVehicleStyleButton];
#endif
    [_pedal setTitle:driving?@"Frenar":@"Saltar" forState:UIControlStateNormal];
    _pedal.accessibilityHint=driving?@"Activa para mantener el freno. Activa otra vez para soltarlo.":nil;
    _speed.hidden=!driving;
    _shownSpeed=-1;
    _nextSpeedUpdate=0;
    [self updateSpeed:0];
    if(driving && !_didShowDriveHint){
        _didShowDriveHint=YES;
        UILabel *hint=_driveHint;
        hint.hidden=NO;
        UIAccessibilityPostNotification(UIAccessibilityAnnouncementNotification,hint.text);
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW,4*NSEC_PER_SEC),dispatch_get_main_queue(),^{hint.hidden=YES;});
    }
}
#ifdef MUNDO_IOS_OWNER_PLAYER
- (void)updateVehicleStyleButton {
    BOOL realistic=_game.realistic();
    [_vehicleStyle setTitle:realistic?@"Turismo realista":@"Turismo en bloques" forState:UIControlStateNormal];
    _vehicleStyle.selected=realistic;
    _vehicleStyle.accessibilityValue=realistic?@"Realista":@"Bloques";
    _vehicleStyle.accessibilityTraits=UIAccessibilityTraitButton | (realistic?UIAccessibilityTraitSelected:0);
}
- (void)toggleVehicleStyle {
    if(!_ready || !_game.room_ready())return;
    if(_game.change_vehicle_style())[self updateVehicleStyleButton];
    else [self notice:@"No se pudo cambiar la apariencia."];
}
#endif
- (void)car {
    if(!_ready)return;
    if(_game.in_room()){
        using mundo::room::CarAction;
        const auto choices=_game.room_seat_choices();
        if(!choices)return;
        UIAlertController *menu=[UIAlertController alertControllerWithTitle:@"Plazas del turismo" message:nil preferredStyle:UIAlertControllerStyleAlert];
        menu.view.accessibilityIdentifier=@"mundo.room.vehicleSeats";
        for(const CarAction choice:{CarAction::enter,CarAction::ride,CarAction::exit}){
            if(!(choices & static_cast<unsigned>(choice)))continue;
            NSString *title=choice==CarAction::enter?@"Tomar el volante":choice==CarAction::ride?@"Subir de pasajero":@"Bajar del carro";
            [menu addAction:[UIAlertAction actionWithTitle:title style:UIAlertActionStyleDefault handler:^(UIAlertAction *action){
                if(const char *reason=self->_game.request_seat(choice))[self notice:[NSString stringWithUTF8String:reason]];
            }]];
        }
        [menu addAction:[UIAlertAction actionWithTitle:@"Cancelar" style:UIAlertActionStyleCancel handler:nil]];
        [self presentViewController:menu animated:YES completion:nil];
        return;
    }

}
- (void)notice:(NSString*)message {
    // A room dialog can still be dismissing when another notice arrives.
    // Present on a free frame, after the controller is active again.
    _pendingNotice=[message copy];
}
- (void)presentNotice:(NSString*)message {
    [self pauseInput];
    UIAlertController *a=[UIAlertController alertControllerWithTitle:@"MUNDO" message:message preferredStyle:UIAlertControllerStyleAlert];
    [a addAction:[UIAlertAction actionWithTitle:@"Cerrar" style:UIAlertActionStyleDefault handler:nil]];
    [self presentViewController:a animated:YES completion:nil];
}
- (void)chooseSettings {
    if(!_ready)return;
    [self pauseInput];
    UIAlertController *panel=[UIAlertController alertControllerWithTitle:@"Ajustes" message:nil preferredStyle:UIAlertControllerStyleAlert];
    [panel addAction:[UIAlertAction actionWithTitle:@"Vídeo" style:UIAlertActionStyleDefault handler:^(UIAlertAction *action){
        [self settings];
    }]];
    [panel addAction:[UIAlertAction actionWithTitle:@"Sonido" style:UIAlertActionStyleDefault handler:^(UIAlertAction *action){
        [self presentViewController:MundoAudioPreferences(self->_game.room_levels(), ^BOOL(mundo::AudioLevels levels){
            return self->_game.save_room_levels(levels);
        }) animated:YES completion:nil];
    }]];
    [panel addAction:[UIAlertAction actionWithTitle:@"Cancelar" style:UIAlertActionStyleCancel handler:nil]];
    [self presentViewController:panel animated:YES completion:nil];
}
- (void)settings {
    if(!_ready)return;
    [self pauseInput];
    NSArray<NSString*> *names=@[@"Automática",@"720p",@"1080p",@"1440p · QHD",@"4K · 2160p",@"8K · 4320p",@"Nativa"];
    auto value=_game.settings();
    const auto dimensions=_game.video_dimensions();
    NSString *summary=[NSString stringWithUTF8String:dimensions.c_str()];
    NSString *help=[NSString stringWithFormat:@"%@\nLímite de FPS (0 = libre). Elige la resolución para guardar.",summary];
    UIAlertController *a=[UIAlertController alertControllerWithTitle:@"Vídeo móvil"
        message:help
        preferredStyle:UIAlertControllerStyleAlert];
    [a addTextFieldWithConfigurationHandler:^(UITextField *f){f.keyboardType=UIKeyboardTypeNumberPad;
        f.text=[NSString stringWithFormat:@"%u",value.fps_cap];}];
    __weak UIAlertController *weakAlert=a;
    for(NSUInteger i=0;i<names.count;i++){
        NSString *title=i==(NSUInteger)value.resolution?[@"✓ " stringByAppendingString:names[i]]:names[i];
        [a addAction:[UIAlertAction actionWithTitle:title style:UIAlertActionStyleDefault handler:^(UIAlertAction *action){
            NSString *s=weakAlert.textFields.firstObject.text;
            if(!s.length||s.length>5||[s rangeOfCharacterFromSet:NSCharacterSet.decimalDigitCharacterSet.invertedSet].location!=NSNotFound ||
               !self->_game.video((unsigned)i,(unsigned)s.integerValue))
                dispatch_async(dispatch_get_main_queue(),^{[self notice:@"Revisa el límite de FPS (0 a 10000) y el almacenamiento disponible."];});
        }]];
    }
    [a addAction:[UIAlertAction actionWithTitle:@"Cancelar" style:UIAlertActionStyleCancel handler:nil]];
    [self presentViewController:a animated:YES completion:nil];
}
- (void)dealloc {[_link invalidate];_viewport.game=nullptr;[NSNotificationCenter.defaultCenter removeObserver:self];}
@end

@interface AppDelegate : UIResponder<UIApplicationDelegate>
@property(nonatomic,strong) UIWindow *window;
@end
@implementation AppDelegate
- (BOOL)application:(UIApplication*)app didFinishLaunchingWithOptions:(NSDictionary*)options {
    self.window=[[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
    self.window.rootViewController=[PlayerController new];[self.window makeKeyAndVisible];return YES;
}
@end
int main(int argc,char** argv){@autoreleasepool{return UIApplicationMain(argc,argv,nil,NSStringFromClass(AppDelegate.class));}}

#import "audio_preferences.h"
#include <cmath>

@interface MundoAudioLevelsController : UITableViewController
- (instancetype)initWithLevels:(mundo::AudioLevels)levels save:(BOOL (^)(mundo::AudioLevels))save;
@end

@implementation MundoAudioLevelsController {
    mundo::AudioLevels _levels;
    BOOL (^_save)(mundo::AudioLevels);
}

- (instancetype)initWithLevels:(mundo::AudioLevels)levels save:(BOOL (^)(mundo::AudioLevels))save {
    if((self=[super initWithStyle:UITableViewStyleGrouped])){
        _levels=levels;
        _save=[save copy];
    }
    return self;
}

- (void)viewDidLoad {
    [super viewDidLoad];
    self.title=@"Sonido de MUNDO";
    self.navigationItem.leftBarButtonItem=[[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemCancel
        target:self action:@selector(cancel)];
    self.navigationItem.rightBarButtonItem=[[UIBarButtonItem alloc] initWithBarButtonSystemItem:UIBarButtonSystemItemSave
        target:self action:@selector(save)];
}

- (void)cancel { [self dismissViewControllerAnimated:YES completion:nil]; }

- (void)save {
    if(_save(_levels)){[self cancel];return;}
    UIAlertController *error=[UIAlertController alertControllerWithTitle:@"No se pudieron guardar los niveles."
        message:nil preferredStyle:UIAlertControllerStyleAlert];
    [error addAction:[UIAlertAction actionWithTitle:@"Aceptar" style:UIAlertActionStyleDefault handler:nil]];
    [self presentViewController:error animated:YES completion:nil];
}

- (NSInteger)tableView:(UITableView*)view numberOfRowsInSection:(NSInteger)section {return 6;}

- (UITableViewCell*)tableView:(UITableView*)view cellForRowAtIndexPath:(NSIndexPath*)index {
    UITableViewCell *cell=[[UITableViewCell alloc] initWithStyle:UITableViewCellStyleDefault reuseIdentifier:nil];
    cell.selectionStyle=UITableViewCellSelectionStyleNone;
    NSArray<NSString*> *labels=@[@"Silenciar partida",@"General",@"Ambiente",@"Efectos",@"Música",@"Voces"];
    cell.textLabel.text=labels[index.row];
    if(index.row==0){
        UISwitch *mute=[UISwitch new];mute.on=_levels.muted;mute.accessibilityLabel=labels[0];
        [mute addTarget:self action:@selector(setMuted:) forControlEvents:UIControlEventValueChanged];
        cell.accessoryView=mute;
    }else{
        UISlider *slider=[[UISlider alloc] initWithFrame:CGRectMake(0,0,145,36)];
        slider.minimumValue=0;slider.maximumValue=100;slider.tag=index.row;
        slider.value=index.row==1?_levels.volume:_levels.groups[index.row-2];
        slider.accessibilityLabel=labels[index.row];
        [self levelChanged:slider];
        [slider addTarget:self action:@selector(levelChanged:) forControlEvents:UIControlEventValueChanged];
        cell.accessoryView=slider;
    }
    return cell;
}

- (void)setMuted:(UISwitch*)sender { _levels.muted=sender.on; }

- (void)levelChanged:(UISlider*)sender {
    const auto value=static_cast<unsigned>(std::lround(sender.value));
    if(sender.tag==1)_levels.volume=value;
    else _levels.groups[sender.tag-2]=value;
    sender.accessibilityValue=[NSString stringWithFormat:@"%u %%",value];
}
@end

UIViewController* MundoAudioPreferences(mundo::AudioLevels levels, BOOL (^save)(mundo::AudioLevels)) {
    auto *controller=[[MundoAudioLevelsController alloc] initWithLevels:levels save:save];
    return [[UINavigationController alloc] initWithRootViewController:controller];
}

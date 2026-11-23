package studio.mundo.player;

import android.app.*;
import android.os.Bundle;
import android.media.AudioManager;
import android.os.PowerManager;
import android.content.Intent;
import android.content.ComponentCallbacks2;
import android.view.*;
import android.widget.*;
import android.text.InputFilter;
import android.text.InputType;
import android.text.TextUtils;
import android.view.inputmethod.EditorInfo;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;

public final class PlayerActivity extends Activity implements SurfaceHolder.Callback, Choreographer.FrameCallback {
    static {
        System.loadLibrary("mundo_mobile");
        RoomTransport.initialize();
    }
    private static native long create();
    private static native void destroy(long h);
    private static native boolean attach(long h, Surface s, String folder);
    private static native void detach(long h);
    private static native void pauseGame(long h);
    private static native void trimWorldCache(long h);
    private static native void deviceBudget(long h,long bytes,boolean lowMemory,boolean lowPower);
    private static native void frame(long h,double time,double hz);
    private static native boolean roomReady(long h);
    private static native boolean roomWantsAudio(long h);
    private static native void roomAudioAllowed(long h,boolean allowed);
    private RoomAudioFocus roomFocus;
    private static native boolean entryVisible(long h);
    static native String invitationOrigin(String link);
    private static native boolean joinRoom(long h,String link);
    private static native void leaveRoom(long h);
    private static native void setRoomActive(long h,boolean active);
    private static native boolean inRoom(long h);
    private static final int DRIVE=1, EXIT_CAR=2, RIDE=4;
    private static native int seatChoices(long h);
    private static native String requestSeat(long h,int action);
    private static native boolean roomHasCar(long h);
    private static native long meetingTicket(long h);
    private static native boolean returnToMeeting(long h,long ticket);
    private static native int roomStatusRevision(long h);
    private static native String roomCarGuide(long h);
    private static native byte[] roomStatusUtf8(long h);
    private static native byte[] roomCourseUtf8(long h);
    private static native void touch(long h,int id,int phase,float x,float y,int w,int height);
    private static native void camera(long h);
    private static native double vehicleSpeed(long h);
    private static native boolean driving(long h);
    private static native void brake(long h,boolean held);
    private static native int ownerStyle(long h,boolean change);
    private static native void jump(long h);
    private static native int option(long h,boolean fps);
    private static native byte[] videoDimensions(long h);
    private static native boolean video(long h,int r,int fps);
    private long handle;
    private boolean active,ready;
    private SurfaceView viewport;
    private Button leap;
    private Button cameraButton,vehicleButton,roomButton,meetingButton,styleButton;
    private TextView lobby;
    private TextView roomLabel,carGuide,courseLabel;
    private long nextCarGuide;
    private boolean lastInRoom,lastReady,lastPreview;
    private String pendingInvitation;
    private AlertDialog invitationDialog;
    private AlertDialog meetingDialog;
    private int lastRoomRevision=-1;
    private long nextRoomStatusUpdate,nextBudgetUpdate;
    private ActivityManager memoryManager;
    private PowerManager powerManager;
    private final ActivityManager.MemoryInfo memoryInfo=new ActivityManager.MemoryInfo();
    private TextView speed;
    private long nextSpeedUpdate;
    private int shownSpeed=Integer.MIN_VALUE;
    private int brakePointer=-1;
    private boolean accessibleBrake,shownDriving;
    private static final int SCAN_SEAT=2;
    private void notice(String text){Toast.makeText(this,text,Toast.LENGTH_LONG).show();}
    @Override public void onCreate(Bundle state){
        super.onCreate(state);
        memoryManager=(ActivityManager)getSystemService(ACTIVITY_SERVICE);
        powerManager=(PowerManager)getSystemService(POWER_SERVICE);
        handle=create();
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
        roomAudioAllowed(handle,false);
        roomFocus=new RoomAudioFocus((AudioManager)getSystemService(AUDIO_SERVICE),
                allowed->{if(handle!=0)roomAudioAllowed(handle,allowed);});
        if(handle==0){notice("MUNDO no pudo iniciar.");finish();return;}
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY |
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_FULLSCREEN);
        FrameLayout layout=new FrameLayout(this);
        viewport=new SurfaceView(this);viewport.setTag("mundo.viewport");layout.addView(viewport);viewport.getHolder().addCallback(this);
        viewport.setOnTouchListener((v,e)->{
            int action=e.getActionMasked(),i=e.getActionIndex();
            if(action==MotionEvent.ACTION_MOVE){
                for(int n=0;n<e.getPointerCount();++n)send(e,n,1);
            }else if(action==MotionEvent.ACTION_CANCEL)send(e,0,3);
            else if(action==MotionEvent.ACTION_DOWN||action==MotionEvent.ACTION_POINTER_DOWN)send(e,i,0);
            else if(action==MotionEvent.ACTION_UP||action==MotionEvent.ACTION_POINTER_UP)send(e,i,2);
            return true;
        });
        LinearLayout actions=new LinearLayout(this);
        lobby=new TextView(this);
        lobby.setGravity(Gravity.CENTER);
        lobby.setTextColor(0xffffffff);lobby.setBackgroundColor(0xff172729);
        lobby.setText("MUNDO en línea · Abre Sala para entrar con tu invitación.");
        lobby.setClickable(true);
        layout.addView(lobby,new FrameLayout.LayoutParams(-1,-1));
        vehicleButton=button(actions,"Plazas",this::vehicleMenu);
        cameraButton=button(actions,"Cámara",()->camera(handle));
        if(ownerStyle(handle,false)>=0)styleButton=button(actions,"Apariencia",()->{
            int style=ownerStyle(handle,true);
            if(style<0)notice("No se pudo cambiar la apariencia.");
            else styleButton.setText(style==1?"Turismo realista":"Turismo en bloques");
        });
        button(actions,"Vídeo",this::settings);
        layout.addView(actions,new FrameLayout.LayoutParams(-2,-2,Gravity.TOP|Gravity.END));
        leap=new Button(this);leap.setText("Saltar");
        leap.setOnClickListener(v->{
            if(handle==0)return;
            if(driving(handle)){
                // An accessibility click can hold and release the brake without a continuous touch.
                accessibleBrake=!accessibleBrake;
                brake(handle,accessibleBrake);
                leap.setSelected(accessibleBrake);
            }else jump(handle);
        });
        leap.setOnTouchListener((v,e)->{
            int action=e.getActionMasked();
            if(handle==0)return false;
            if(action==MotionEvent.ACTION_DOWN && driving(handle)){
                releaseBrake();
                brakePointer=e.getPointerId(0);brake(handle,true);v.setPressed(true);return true;
            }
            if(brakePointer<0)return false;
            if(action==MotionEvent.ACTION_CANCEL || ((action==MotionEvent.ACTION_UP||action==MotionEvent.ACTION_POINTER_UP)
                    && e.getPointerId(e.getActionIndex())==brakePointer))releaseBrake();
            return true;
        });
        LinearLayout pedals=new LinearLayout(this);
        pedals.setOrientation(LinearLayout.VERTICAL);pedals.setGravity(Gravity.END);
        speed=new TextView(this);speed.setTag("mundo.speed");speed.setVisibility(View.GONE);
        speed.setTextColor(0xffffffff);speed.setBackgroundColor(0xb0203032);
        pedals.addView(speed);pedals.addView(leap);
        layout.addView(pedals,new FrameLayout.LayoutParams(-2,-2,Gravity.BOTTOM|Gravity.END));
        LinearLayout roomBox=new LinearLayout(this);
        roomBox.setOrientation(LinearLayout.VERTICAL);
        roomBox.setGravity(Gravity.START);
        roomLabel=new TextView(this);
        roomLabel.setTag("mundo.roomStatus");
        roomLabel.setTextColor(0xffffffff);
        roomLabel.setBackgroundColor(0xb0203032);
        roomLabel.setMaxWidth((int)(200*getResources().getDisplayMetrics().density));
        roomLabel.setMaxLines(2);roomLabel.setEllipsize(TextUtils.TruncateAt.END);
        roomLabel.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        roomLabel.setVisibility(View.GONE);roomBox.addView(roomLabel);
        courseLabel=new TextView(this);
        courseLabel.setTag("mundo.room.circuit");
        courseLabel.setTextColor(0xffffffff);courseLabel.setBackgroundColor(0xb0203032);
        courseLabel.setMaxWidth((int)(280*getResources().getDisplayMetrics().density));
        courseLabel.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        courseLabel.setVisibility(View.GONE);roomBox.addView(courseLabel);
        carGuide=new TextView(this);
        carGuide.setTag("mundo.room.carGuide");
        carGuide.setTextColor(0xffffffff);carGuide.setBackgroundColor(0xb0203032);
        carGuide.setVisibility(View.GONE);roomBox.addView(carGuide);
        meetingButton=button(roomBox,"Encuentro",this::confirmMeeting);
        meetingButton.setTag("mundo.room.meeting");
        meetingButton.setContentDescription("Volver al punto de encuentro");
        meetingButton.setVisibility(View.GONE);
        roomButton=button(roomBox,"Sala",this::roomAction);
        roomButton.setTag("mundo.room");roomButton.setContentDescription("Entrar a una sala privada");
        layout.addView(roomBox,new FrameLayout.LayoutParams(-2,-2,Gravity.BOTTOM|Gravity.START));
        layout.setOnApplyWindowInsetsListener((v,insets)->{
            int left=insets.getStableInsetLeft(),right=insets.getStableInsetRight();
            int top=insets.getStableInsetTop(),bottom=insets.getStableInsetBottom();
            if(android.os.Build.VERSION.SDK_INT>=28 && insets.getDisplayCutout()!=null){
                android.view.DisplayCutout cut=insets.getDisplayCutout();
                left=Math.max(left,cut.getSafeInsetLeft());right=Math.max(right,cut.getSafeInsetRight());
                top=Math.max(top,cut.getSafeInsetTop());bottom=Math.max(bottom,cut.getSafeInsetBottom());
            }
            FrameLayout.LayoutParams a=(FrameLayout.LayoutParams)actions.getLayoutParams();
            a.setMargins(left,top,right,0);actions.setLayoutParams(a);
            FrameLayout.LayoutParams b=(FrameLayout.LayoutParams)pedals.getLayoutParams();
            b.setMargins(left,0,right,bottom);pedals.setLayoutParams(b);
            FrameLayout.LayoutParams c=(FrameLayout.LayoutParams)roomBox.getLayoutParams();
            c.setMargins(left,0,right,bottom);roomBox.setLayoutParams(c);
            return insets;
        });
        setContentView(layout);updateRoomControls();
        if(state==null)receive(getIntent());
    }
    @Override protected void onNewIntent(Intent intent){
        super.onNewIntent(intent);setIntent(intent);receive(intent);
    }
    private void receive(Intent intent){
        if(handle==0||intent==null)return;
        if(Intent.ACTION_SEND.equals(intent.getAction()) && "text/plain".equals(intent.getType())){
            // A shared invitation belongs to this interaction, not the activity's saved launch intent.
            setIntent(new Intent(this,PlayerActivity.class).setAction(Intent.ACTION_MAIN));
            CharSequence text=null;
            try {
                text=intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
                if(text==null && intent.getClipData()!=null && intent.getClipData().getItemCount()==1)
                    text=intent.getClipData().getItemAt(0).getText();
            } catch(RuntimeException ignored) {}
            String candidate=text!=null && text.length()<=256 ? text.toString().trim() : "";
            if(invitationOrigin(candidate)==null){notice("Comparte el enlace completo de una invitación de MUNDO.");return;}
            if(inRoom(handle)){notice("Sal de la sala actual antes de abrir otra invitación.");return;}
            pendingInvitation=candidate;
            showSharedInvitation();
            return;
        }
    }
    private void showSharedInvitation(){
        if(pendingInvitation==null || !active || !ready || handle==0 || isFinishing())return;
        String link=pendingInvitation;
        pendingInvitation=null;
        if(inRoom(handle)){notice("Sal de la sala actual antes de abrir otra invitación.");return;}
        if(invitationDialog!=null)invitationDialog.dismiss();
        String origin=invitationOrigin(link);
        if(origin==null){notice("Revisa la invitación de tu asiento.");return;}
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle("Invitación de MUNDO")
            .setMessage("¿Entrar en la sala de "+origin+"?")
            .setNegativeButton("Cancelar",null)
            .setPositiveButton("Entrar",(d,which)->{
                if(handle==0 || !ready || inRoom(handle) || !joinRoom(handle,link)){
                    notice("No se pudo abrir la invitación en esta partida.");return;
                }
                updateRoomControls();
            }).create();
        invitationDialog=dialog;
        dialog.setOnDismissListener(d->{if(invitationDialog==dialog)invitationDialog=null;});
        dialog.show();
    }
    private Button button(LinearLayout bar,String label,Runnable action){
        Button b=new Button(this);b.setText(label);b.setOnClickListener(v->action.run());bar.addView(b);return b;
    }
    private void roomAction(){
        if(handle==0||!ready)return;
        if(inRoom(handle)){
            leaveRoom(handle);
            updateRoomControls();
            return;
        }
        EditText link=new EditText(this);
        link.setSingleLine(true);link.setHint("Enlace de invitación");
        link.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_URI|InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        link.setFilters(new InputFilter[]{new InputFilter.LengthFilter(256)});
        link.setSaveEnabled(false);link.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        link.setImeOptions(EditorInfo.IME_ACTION_GO|EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING);
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle("Entrar a una sala privada")
            .setView(link).setNegativeButton("Cancelar",null).setPositiveButton("Entrar",null)
            .setNeutralButton("Escanear QR",(d,which)->{
                if(handle!=0 && ready && !inRoom(handle))
                    startActivityForResult(new Intent(this,SeatScannerActivity.class),SCAN_SEAT);
            }).create();
        dialog.setOnShowListener(ignored->{
            Button enter=dialog.getButton(AlertDialog.BUTTON_POSITIVE);
            enter.setOnClickListener(v->{
                if(handle==0){dialog.dismiss();return;}
                if(!joinRoom(handle,link.getText().toString().trim())){
                    link.setError("Pega el enlace completo de la sala privada.");return;
                }
                updateRoomControls();
                dialog.dismiss();
            });
            link.setOnEditorActionListener((view,action,event)->{
                if(action!=EditorInfo.IME_ACTION_GO)return false;
                enter.performClick();return true;
            });
        });
        invitationDialog=dialog;
        dialog.setOnDismissListener(ignored->{
            link.getText().clear();
            if(invitationDialog==dialog)invitationDialog=null;
        });
        dialog.show();
    }
    private void confirmMeeting(){
        if(handle==0 || !active || !ready || meetingDialog!=null)return;
        final long ticket=meetingTicket(handle);
        if(ticket==0)return;
        releaseBrake();
        pauseGame(handle);
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle("Punto de encuentro")
            .setMessage("¿Volver al punto de encuentro de esta sala?")
            .setNegativeButton("Cancelar",null).setPositiveButton("Volver",(d,which)->{
                if(handle==0 || !active || !ready)return;
                if(!returnToMeeting(handle,ticket))notice("El regreso ya no está disponible.");
                updateRoomControls();
            }).create();
        meetingDialog=dialog;
        dialog.setOnDismissListener(ignored->{if(meetingDialog==dialog)meetingDialog=null;});
        dialog.show();
    }
    private void updateRoomControls(){
        int revision=roomStatusRevision(handle);
        final boolean playable=roomReady(handle);
        final boolean preview=entryVisible(handle);
        if(revision==lastRoomRevision && playable==lastReady && preview==lastPreview)return;
        lastReady=playable;lastPreview=preview;
        lastRoomRevision=revision;
        boolean online=inRoom(handle);
        if(!playable)carGuide.setVisibility(View.GONE);
        meetingButton.setVisibility(meetingTicket(handle)!=0?View.VISIBLE:View.GONE);
        byte[] utf8=roomStatusUtf8(handle);
        String status=utf8==null?"":new String(utf8,StandardCharsets.UTF_8);
        lobby.setVisibility(playable||preview?View.GONE:View.VISIBLE);
        lobby.setText(status.isEmpty()?"MUNDO en línea · Abre Sala para entrar con tu invitación.":
            online?status:status+"  ·  Abre Sala para entrar.");
        cameraButton.setVisibility(playable?View.VISIBLE:View.GONE);
        if(styleButton!=null)styleButton.setVisibility(playable&&roomHasCar(handle)?View.VISIBLE:View.GONE);
        byte[] courseBytes=playable?roomCourseUtf8(handle):null;
        String course=courseBytes==null?"":new String(courseBytes,StandardCharsets.UTF_8);
        if(!TextUtils.equals(course,courseLabel.getText()))courseLabel.setText(course);
        courseLabel.setVisibility(course.isEmpty()?View.GONE:View.VISIBLE);
        roomLabel.setText(preview?"Zona de entrada · "+(status.isEmpty()?"Cargando partida…":status):status);
        roomLabel.setVisibility(preview || (playable&&!status.isEmpty())?View.VISIBLE:View.GONE);
        boolean changed=online!=lastInRoom;
        if(changed){
            lastInRoom=online;nextCarGuide=0;
            if(!online)carGuide.setVisibility(View.GONE);
            roomButton.setText(online?"Salir de la sala":"Sala");
            roomButton.setContentDescription(online?"Salir de la sala":"Entrar a una sala privada");
            if(!online&&!status.isEmpty())notice(status);
        }
        vehicleButton.setVisibility(playable&&roomHasCar(handle)?View.VISIBLE:View.GONE);
        boolean aboard=driving(handle);
        vehicleButton.setText(online?"Plazas":"Carro");
        vehicleButton.setContentDescription(online?"Elegir plaza o bajar del carro":"Carro");
        boolean passenger=online && !aboard && (seatChoices(handle)&EXIT_CAR)!=0;
        leap.setVisibility(!playable||passenger?View.GONE:View.VISIBLE);
        if(changed||aboard!=shownDriving)updatePedal();
    }
    private void releaseBrake(){
        if((brakePointer>=0 || accessibleBrake) && handle!=0)brake(handle,false);
        brakePointer=-1;
        accessibleBrake=false;
        if(leap!=null){leap.setPressed(false);leap.setSelected(false);}
    }
    private void updatePedal(){
        releaseBrake();
        boolean aboard=driving(handle);
        shownDriving=aboard;
        leap.setText(aboard?"Frenar":"Saltar");
        speed.setVisibility(aboard?View.VISIBLE:View.GONE);
        shownSpeed=Integer.MIN_VALUE;nextSpeedUpdate=0;
        if(aboard)updateSpeed(0);
        if(aboard)notice("Usa la mitad izquierda para acelerar y girar. Mantén Frenar para detenerte.");
    }
    private void updateSpeed(long time){
        if(speed.getVisibility()!=View.VISIBLE||time<nextSpeedUpdate)return;
        nextSpeedUpdate=time+200_000_000L;
        int kmh=(int)Math.round(Math.abs(vehicleSpeed(handle))*3.6);
        if(kmh!=shownSpeed){speed.setText(kmh+" km/h");shownSpeed=kmh;}
    }
    private void vehicleMenu(){
        if(!ready || handle==0)return;
        if(inRoom(handle)){
            final int choices=seatChoices(handle);
            if(choices==0)return;
            ArrayList<String> labels=new ArrayList<>();
            ArrayList<Integer> actions=new ArrayList<>();
            if((choices&DRIVE)!=0){labels.add("Tomar el volante");actions.add(DRIVE);}
            if((choices&RIDE)!=0){labels.add("Subir de pasajero");actions.add(RIDE);}
            if((choices&EXIT_CAR)!=0){labels.add("Bajar del carro");actions.add(EXIT_CAR);}
            new AlertDialog.Builder(this).setTitle("Plazas del turismo")
                .setItems(labels.toArray(new String[0]),(dialog,index)->{
                    if(handle==0)return;
                    String error=requestSeat(handle,actions.get(index));
                    if(error!=null)notice(error);
                }).setNegativeButton("Cancelar",null).show();
            return;
        }
    }
    private void send(MotionEvent e,int i,int phase){
        if(handle!=0)touch(handle,e.getPointerId(i),phase,e.getX(i),e.getY(i),viewport.getWidth(),viewport.getHeight());
    }
    private void schedule(){
        Choreographer c=Choreographer.getInstance();c.removeFrameCallback(this);
        if(active && ready && hasWindowFocus())c.postFrameCallback(this);
        else if(handle!=0){releaseBrake();pauseGame(handle);}
    }
    private void updateDeviceBudget(long time){
        if(time<nextBudgetUpdate || !inRoom(handle))return;
        nextBudgetUpdate=time+2_000_000_000L;
        long bytes=0;
        boolean low=false;
        if(memoryManager!=null){
            memoryManager.getMemoryInfo(memoryInfo);
            long mib=1024L*1024L;
            long spare=Math.max(0L,memoryInfo.availMem-memoryInfo.threshold);
            bytes=Math.max(24*mib,Math.min(4096*mib,Math.min(memoryInfo.totalMem/16,spare/12)));
            low=memoryInfo.lowMemory;
        }
        deviceBudget(handle,bytes,low,powerManager!=null && powerManager.isPowerSaveMode());
    }
    @Override public void doFrame(long time){
        if(!active||!ready||!hasWindowFocus())return;
        updateDeviceBudget(time);
        frame(handle,time*1e-9,viewport.getDisplay().getRefreshRate());
        if(time>=nextRoomStatusUpdate || roomReady(handle)!=lastReady || entryVisible(handle)!=lastPreview){
            roomFocus.update(roomWantsAudio(handle));
            nextRoomStatusUpdate=time+100_000_000L;
            updateRoomControls();
        }
        if(lastInRoom && time>=nextCarGuide){
            nextCarGuide=time+1_000_000_000L;
            String guide=roomCarGuide(handle);
            if(guide!=null && !guide.contentEquals(carGuide.getText()))carGuide.setText(guide);
            carGuide.setVisibility(guide==null?View.GONE:View.VISIBLE);
        }
        updateSpeed(time);
        if(inRoom(handle))Choreographer.getInstance().postFrameCallback(this);
        else Choreographer.getInstance().postFrameCallbackDelayed(this,250);
    }
    @Override public void surfaceCreated(SurfaceHolder holder){
        if(handle==0)return;
        ready=attach(handle,holder.getSurface(),getFilesDir().getAbsolutePath());
        if(!ready)notice("No se pudo abrir la pantalla de MUNDO.");
        showSharedInvitation();schedule();
    }
    @Override public void surfaceChanged(SurfaceHolder h,int format,int width,int height){}
    @Override public void surfaceDestroyed(SurfaceHolder h){
        ready=false;roomFocus.update(false);schedule();
        if(handle!=0){detach(handle);updateRoomControls();}
    }
    @Override public void onWindowFocusChanged(boolean focus){
        super.onWindowFocusChanged(focus);
        if(!focus && roomFocus!=null)roomFocus.update(false);
        if(!focus && lastPreview){
            lobby.setVisibility(View.VISIBLE);
            roomLabel.setVisibility(View.GONE);
            lastPreview=false;
        }
        schedule();
    }
    @Override protected void onResume(){
        super.onResume();active=true;nextBudgetUpdate=0;
        showSharedInvitation();
        if(handle!=0){setRoomActive(handle,true);updateRoomControls();}
        schedule();
    }
    @Override protected void onPause(){active=false;
        if(roomFocus!=null)roomFocus.update(false);
        if(meetingDialog!=null)meetingDialog.dismiss();
        if(handle!=0){setRoomActive(handle,false);updateRoomControls();}
        schedule();
        super.onPause();}
    private void trimRoomCache(){
        // Read the live handle on the same thread that retires it in onDestroy.
        runOnUiThread(()->{if(handle!=0){trimWorldCache(handle);updateRoomControls();}});
    }
    @Override public void onTrimMemory(int level){
        super.onTrimMemory(level);
        boolean runningLow=level>=ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW &&
                           level<ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN;
        if(runningLow || level>=ComponentCallbacks2.TRIM_MEMORY_BACKGROUND)trimRoomCache();
    }
    @Override public void onLowMemory(){
        super.onLowMemory();
        trimRoomCache();
    }
    @Override protected void onDestroy(){
        pendingInvitation=null;
        if(meetingDialog!=null)meetingDialog.dismiss();
        if(invitationDialog!=null)invitationDialog.dismiss();
        ready=false;
        active=false;
        if(roomFocus!=null)roomFocus.update(false);
        schedule();
        long retired=handle;
        handle=0;
        if(retired!=0){
            // Release the drawing surface on its owning thread. A final network timeout
            // may outlast the Activity, so drain the retired session away from Android's UI.
            leaveRoom(retired);
            detach(retired);
            new Thread(()->destroy(retired),"MUNDO room cleanup").start();
        }
        super.onDestroy();
    }
    private void settings(){
        if(!ready)return;
        LinearLayout box=new LinearLayout(this);box.setOrientation(LinearLayout.VERTICAL);
        Spinner resolution=new Spinner(this);
        byte[] summary=videoDimensions(handle);
        if(summary!=null){
            TextView dimensions=new TextView(this);
            dimensions.setText(new String(summary,StandardCharsets.UTF_8));box.addView(dimensions);
        }
        String[] names={"Automática","720p","1080p","1440p · QHD","4K · 2160p","8K · 4320p","Nativa"};
        resolution.setAdapter(new ArrayAdapter<>(this,android.R.layout.simple_spinner_dropdown_item,names));
        resolution.setSelection(option(handle,false));box.addView(resolution);
        TextView label=new TextView(this);label.setText("Límite de FPS · 0 = libre");box.addView(label);
        EditText fps=new EditText(this);fps.setInputType(InputType.TYPE_CLASS_NUMBER);
        fps.setText(String.valueOf(option(handle,true)));box.addView(fps);
        new AlertDialog.Builder(this).setTitle("Vídeo móvil").setView(box).setNegativeButton("Cancelar",null)
            .setPositiveButton("Guardar",(d,w)->{try{
                if(!video(handle,resolution.getSelectedItemPosition(),Integer.parseInt(fps.getText().toString())))notice("No se pudieron guardar los ajustes.");
            }catch(NumberFormatException ex){notice("Introduce un límite entre 0 y 10000.");}}).show();
    }
    @Override protected void onActivityResult(int request,int result,Intent data){
        super.onActivityResult(request,result,data);
        if(request==SCAN_SEAT){
            if(handle!=0 && result==RESULT_OK && data!=null && !inRoom(handle)){
                String link=data.getStringExtra(SeatScannerActivity.INVITATION);
                if(SeatScannerActivity.isLanInvitation(link)){
                    pendingInvitation=link;
                    showSharedInvitation();
                }
            }
            return;
        }
    }
}

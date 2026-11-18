#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <Speech/Speech.h>

typedef void (*SpeechCallback)(const char *);
@interface VTSpeech : NSObject
@property(nonatomic, copy) NSString *session;
@property(nonatomic, copy) NSString *text;
@property(nonatomic, strong) AVAudioEngine *engine;
@property(nonatomic, strong) SFSpeechRecognizer *recognizer;
@property(nonatomic, strong) SFSpeechAudioBufferRecognitionRequest *request;
@property(nonatomic, strong) SFSpeechRecognitionTask *task;
@property(nonatomic, strong) NSTimer *silence;
@property(nonatomic, strong) NSTimer *deadline;
@property(nonatomic) SpeechCallback callback;
@property(nonatomic) BOOL active;
@property(nonatomic) BOOL tapInstalled;
@property(nonatomic) NSUInteger generation;
@property(nonatomic) NSUInteger retryCount;
- (void)emit:(NSString *)kind text:(NSString *)text;
- (void)finish:(NSString *)kind text:(NSString *)text;
- (void)begin:(NSString *)locale;
- (void)releaseAudio;
@end
@implementation VTSpeech
- (void)emit:(NSString *)kind text:(NSString *)text {
    NSDictionary *event = @{ @"id":self.session, @"kind":kind, @"text":text ?: @"" };
    NSData *data = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    self.callback(json.UTF8String);
}
- (void)releaseAudio {
    ++self.generation;
    [self.silence invalidate]; [self.deadline invalidate];
    self.silence = nil; self.deadline = nil;
    if (self.engine) {
        [self.engine stop];
        if (self.tapInstalled) [self.engine.inputNode removeTapOnBus:0];
        self.tapInstalled = NO;
    }
    [self.request endAudio];
    [self.task cancel];
    self.task = nil; self.request = nil; self.engine = nil; self.recognizer = nil;
}
- (void)finish:(NSString *)kind text:(NSString *)text {
    if (!self.active) return;
    self.active = NO;
    [self releaseAudio];
    [self emit:kind text:text];
}
- (void)begin:(NSString *)locale {
    if (!self.active) return;
    @try {
        self.recognizer = [[SFSpeechRecognizer alloc] initWithLocale:[NSLocale localeWithLocaleIdentifier:locale]];
        if (!self.recognizer || !self.recognizer.available) {
            [self finish:@"error" text:@"Pengenal ucapan bahasa Indonesia tidak tersedia. Periksa koneksi dan pengaturan Dictation macOS."]; return;
        }
        self.engine = [[AVAudioEngine alloc] init];
        self.request = [[SFSpeechAudioBufferRecognitionRequest alloc] init];
        self.request.shouldReportPartialResults = YES;
        self.request.taskHint = SFSpeechRecognitionTaskHintDictation;
        // Indonesian on-device recognition is not available on all Macs.
        // User-facing controls disclose that Apple may process recognition online.
        AVAudioInputNode *input = self.engine.inputNode;
        AVAudioFormat *format = [input outputFormatForBus:0];
        if (format.sampleRate == 0 || format.channelCount == 0) {
            self.engine = nil;
            [self finish:@"error" text:@"Mikrofon tidak tersedia."]; return;
        }
        SFSpeechAudioBufferRecognitionRequest *request = self.request;
        AVAudioNodeTapBlock tap = ^(AVAudioPCMBuffer *buffer, AVAudioTime *time) {
            (void)time;
            [request appendAudioPCMBuffer:buffer];
        };
#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 270000
        if (@available(macOS 27.0, *)) {
            NSError *tapError = nil;
            if (![input installTapOnBus:0 bufferSize:1024 format:format error:&tapError block:tap]) {
                [self finish:@"error" text:tapError.localizedDescription]; return;
            }
        } else
#endif
        {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
            [input installTapOnBus:0 bufferSize:1024 format:format block:tap];
#pragma clang diagnostic pop
        }
        self.tapInstalled = YES;
        __weak VTSpeech *weakSelf = self;
        NSUInteger generation = self.generation;
        self.task = [self.recognizer recognitionTaskWithRequest:self.request resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
            dispatch_async(dispatch_get_main_queue(), ^{
                VTSpeech *owner = weakSelf;
                if (!owner.active || owner.generation != generation) return;
                if (result) {
                    NSString *text = result.bestTranscription.formattedString;
                    if (![text isEqualToString:owner.text]) {
                        owner.text = text;
                        [owner emit:@"partial" text:text];
                        [owner.silence invalidate];
                        owner.silence = [NSTimer scheduledTimerWithTimeInterval:1.5 repeats:NO block:^(NSTimer *timer) {
                            (void)timer;
                            [owner finish:@"final" text:owner.text];
                        }];
                    }
                    if (result.isFinal) { [owner finish:@"final" text:owner.text]; return; }
                }
                if (error) {
                    // Apple's online service can return a transient Retry before any result.
                    BOOL retry = [error.domain isEqualToString:@"kAFAssistantErrorDomain"] && error.code == 203;
                    if (retry && owner.text.length == 0 && owner.retryCount == 0) {
                        owner.retryCount++;
                        [owner releaseAudio];
                        NSUInteger retryGeneration = owner.generation;
                        [owner emit:@"authorizing" text:@"Menghubungkan ulang pengenal ucapan…"];
                        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 500 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
                            if (owner.active && owner.generation == retryGeneration) [owner begin:locale];
                        });
                    } else if (owner.text.length > 0) {
                        [owner finish:@"final" text:owner.text];
                    } else {
                        NSString *message = retry
                            ? @"Layanan pengenal ucapan Apple gagal terhubung (203). Periksa internet dan aktifkan Dictation di System Settings → Keyboard, lalu tekan ikon mikrofon lagi."
                            : [NSString stringWithFormat:@"Pengenalan ucapan gagal (%@/%ld): %@", error.domain, (long)error.code, error.localizedDescription];
                        [owner finish:@"error" text:message];
                    }
                }
            });
        }];
        [self.engine prepare];
        NSError *error = nil;
        if (![self.engine startAndReturnError:&error]) {
            [self finish:@"error" text:error.localizedDescription]; return;
        }
        [self emit:@"listening" text:@""];
        self.deadline = [NSTimer scheduledTimerWithTimeInterval:45 repeats:NO block:^(NSTimer *timer) {
            (void)timer;
            VTSpeech *owner = weakSelf;
            [owner finish:owner.text.length ? @"final" : @"error" text:owner.text.length ? owner.text : @"Tidak ada ucapan terdeteksi. Tekan ikon mikrofon untuk mencoba lagi."];
        }];
    } @catch (NSException *exception) {
        [self finish:@"error" text:exception.reason];
    }
}
@end
static VTSpeech *currentSpeech;

void vt_speech_stop(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        [currentSpeech finish:@"stopped" text:@""];
        currentSpeech = nil;
    });
}
void vt_speech_start(const char *identifier, const char *language, SpeechCallback callback) {
    NSString *session = [NSString stringWithUTF8String:identifier];
    NSString *locale = [NSString stringWithUTF8String:language];
    dispatch_async(dispatch_get_main_queue(), ^{
        [currentSpeech finish:@"stopped" text:@""];
        VTSpeech *owner = [[VTSpeech alloc] init];
        currentSpeech = owner;
        owner.session = session; owner.text = @""; owner.callback = callback; owner.active = YES;
        [owner emit:@"authorizing" text:@""];
        [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (!owner.active) return;
                if (status != SFSpeechRecognizerAuthorizationStatusAuthorized) {
                    [owner finish:@"error" text:@"Izin Speech Recognition ditolak. Aktifkan di System Settings → Privacy & Security → Speech Recognition."]; return;
                }
                [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
                    dispatch_async(dispatch_get_main_queue(), ^{
                        if (!owner.active) return;
                        if (!granted) { [owner finish:@"error" text:@"Izin mikrofon ditolak. Aktifkan di System Settings → Privacy & Security → Microphone."]; return; }
                        [owner begin:locale];
                    });
                }];
            });
        }];
    });
}

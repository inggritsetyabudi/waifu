#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <CoreGraphics/CoreGraphics.h>
#include <stdlib.h>
#include <string.h>

int vt_screen_permission(void) {
    if (![NSBundle.mainBundle.bundlePath.pathExtension isEqualToString:@"app"]) return -1;
    return CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess();
}
char *vt_read_screen_text(const char *filename) {
    @autoreleasepool {
        NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:filename]];
        VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
        request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
        request.usesLanguageCorrection = YES;
        // Latin-script Indonesian is readable via English OCR; include Japanese UI text.
        NSArray<NSString *> *supported;
        if (@available(macOS 12.0, *)) {
            supported = [request supportedRecognitionLanguagesAndReturnError:nil];
        } else {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
            supported = [VNRecognizeTextRequest supportedRecognitionLanguagesForTextRecognitionLevel:request.recognitionLevel revision:request.revision error:nil];
#pragma clang diagnostic pop
        }
        NSMutableArray<NSString *> *languages = [NSMutableArray arrayWithObject:@"en-US"];
        if ([supported containsObject:@"id-ID"]) [languages insertObject:@"id-ID" atIndex:0];
        if ([supported containsObject:@"ja-JP"]) [languages addObject:@"ja-JP"];
        request.recognitionLanguages = languages;
        VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithURL:url options:@{}];
        NSError *error = nil;
        NSMutableArray<NSString *> *lines = [NSMutableArray array];
        BOOL success = [handler performRequests:@[request] error:&error];
        if (success) {
            for (VNRecognizedTextObservation *item in request.results) {
                VNRecognizedText *candidate = [item topCandidates:1].firstObject;
                if (candidate.string.length) [lines addObject:candidate.string];
            }
        }
        NSDictionary *result = success ? @{ @"text": [lines componentsJoinedByString:@"\n"] }
            : @{ @"error": @"Tidak dapat membaca teks dari tangkapan layar." };
        NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
        return strdup([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    }
}
void vt_free_screen_result(char *result) { free(result); }

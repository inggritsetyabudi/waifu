#import <AppKit/AppKit.h>
#include <stdlib.h>
extern char *vt_read_screen_text(const char *filename);
extern void vt_free_screen_result(char *result);
int main(void) { @autoreleasepool {
    NSString *path = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    NSBitmapImageRep *image = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:900 pixelsHigh:180 bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSCalibratedRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    NSGraphicsContext *context = [NSGraphicsContext graphicsContextWithBitmapImageRep:image];
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:context];
    [NSColor.whiteColor setFill]; NSRectFill(NSMakeRect(0,0,900,180));
    [@"Error: file not found" drawAtPoint:NSMakePoint(30,85) withAttributes:@{NSFontAttributeName:[NSFont systemFontOfSize:36],NSForegroundColorAttributeName:NSColor.blackColor}];
    [NSGraphicsContext restoreGraphicsState];
    [[image representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:path atomically:YES];
    char *result = vt_read_screen_text(path.UTF8String);
    NSString *json = result ? [NSString stringWithUTF8String:result] : @"";
    BOOL success = [json.lowercaseString containsString:@"file not found"];
    vt_free_screen_result(result);
    [NSFileManager.defaultManager removeItemAtPath:path error:nil];
    puts(success ? "PASS: native Vision reads text from a generated fixture, without screen capture" : "FAIL: native OCR");
    return success ? 0 : 1;
} }

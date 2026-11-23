#import <Foundation/Foundation.h>
#import <CommonCrypto/CommonDigest.h>
#import <Security/SecRandom.h>
#import <dispatch/dispatch.h>

#include "room_http.hpp"
#include "mundo/project.hpp"
#include <array>
#include <chrono>
#include <exception>
#include <utility>

using mundo::room::Response;

// The delegate queue alone writes the reply. The network worker reads it after the completion signal.
@interface MundoRoomTransfer : NSObject {
@public
    Response reply;
    std::size_t limit;
    NSString *expectedType;
    BOOL doneAtHeaders;
    dispatch_semaphore_t finished;
}
@end
@implementation MundoRoomTransfer
- (instancetype)init {
    if ((self = [super init])) finished = dispatch_semaphore_create(0);
    return self;
}
@end

@interface MundoRoomDelegate : NSObject <NSURLSessionDataDelegate>
- (void)bind:(NSURLSessionTask *)task transfer:(MundoRoomTransfer *)transfer;
- (void)forget:(NSURLSessionTask *)task;
@end

@implementation MundoRoomDelegate {
    NSURLSessionTask *_task;
    MundoRoomTransfer *_transfer;
}
- (void)bind:(NSURLSessionTask *)task transfer:(MundoRoomTransfer *)transfer {
    @synchronized(self) { _task = task; _transfer = transfer; }
}
- (MundoRoomTransfer *)transferFor:(NSURLSessionTask *)task {
    @synchronized(self) { return task == _task ? _transfer : nil; }
}
- (void)forget:(NSURLSessionTask *)task {
    @synchronized(self) {
        if (task == _task) { _transfer = nil; _task = nil; }
    }
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task
    willPerformHTTPRedirection:(NSHTTPURLResponse *)response newRequest:(NSURLRequest *)request
    completionHandler:(void (^)(NSURLRequest *))completionHandler {
    completionHandler(nil);
}
- (void)URLSession:(NSURLSession *)session didReceiveChallenge:(NSURLAuthenticationChallenge *)challenge
    completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential *))completionHandler {
    const BOOL serverTrust = [challenge.protectionSpace.authenticationMethod isEqualToString:NSURLAuthenticationMethodServerTrust];
    completionHandler(serverTrust ? NSURLSessionAuthChallengePerformDefaultHandling : NSURLSessionAuthChallengeCancelAuthenticationChallenge, nil);
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task
    didReceiveChallenge:(NSURLAuthenticationChallenge *)challenge
    completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential *))completionHandler {
    [self URLSession:session didReceiveChallenge:challenge completionHandler:completionHandler];
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task
    didReceiveResponse:(NSURLResponse *)response
    completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
    MundoRoomTransfer *transfer = [self transferFor:task];
    if (!transfer || ![response isKindOfClass:NSHTTPURLResponse.class]) {
        completionHandler(NSURLSessionResponseCancel);
        return;
    }
    const NSInteger status = ((NSHTTPURLResponse *)response).statusCode;
    if (status < 100 || status > 599) {
        completionHandler(NSURLSessionResponseCancel);
        return;
    }
    if (status != 200 || !transfer->expectedType) {
        // Errors and status-only acknowledgements do not carry player data.
        transfer->reply.status = static_cast<unsigned>(status);
        transfer->doneAtHeaders = YES;
        completionHandler(NSURLSessionResponseCancel);
        return;
    }
    if (![response.MIMEType.lowercaseString isEqualToString:transfer->expectedType] ||
        response.expectedContentLength > static_cast<long long>(transfer->limit)) {
        completionHandler(NSURLSessionResponseCancel);
        return;
    }
    transfer->reply.status = 200;
    completionHandler(NSURLSessionResponseAllow);
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveData:(NSData *)data {
    MundoRoomTransfer *transfer = [self transferFor:task];
    if (!transfer || !data.length) return;
    auto &reply = transfer->reply;
    if (reply.status != 200 || data.length > transfer->limit - reply.body.size()) {
        reply = {};
        [task cancel];
        return;
    }
    const auto *first = static_cast<const std::byte *>(data.bytes);
    try {
        reply.body.insert(reply.body.end(), first, first + data.length);
    } catch (const std::exception &) {
        reply = {};
        [task cancel];
    }
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
    MundoRoomTransfer *transfer = [self transferFor:task];
    if (!transfer) return;
    if (error && !transfer->doneAtHeaders) transfer->reply = {};
    [self forget:task];
    dispatch_semaphore_signal(transfer->finished);
}
@end

namespace mundo::room {
namespace {
constexpr std::size_t max_world_size = 24 * 1024 * 1024;

NSString *ascii(std::string_view value) {
    return [[NSString alloc] initWithBytes:value.data() length:value.size() encoding:NSASCIIStringEncoding];
}
}

std::optional<std::string> new_proof() {
    std::array<unsigned char,24> bytes{};
    if (SecRandomCopyBytes(kSecRandomDefault, bytes.size(), bytes.data()) != 0) return {};
    return hex_text(bytes);
}

bool matches_digest(std::span<const std::byte> bytes, std::string_view revision) {
    if (bytes.empty() || bytes.size() > project::max_room_bytes || revision.size() != CC_SHA256_DIGEST_LENGTH * 2) return false;
    std::array<unsigned char,CC_SHA256_DIGEST_LENGTH> digest{};
    return CC_SHA256(bytes.data(), static_cast<CC_LONG>(bytes.size()), digest.data()) &&
           hex_text(digest) == revision;
}

struct Http::Impl {
    NSString *origin;
    NSString *token;
    NSString *proof;
    MundoRoomDelegate *delegate;
    NSURLSession *session;
    ~Impl() { [session invalidateAndCancel]; }
};

Http::Http(const Invitation &invite, std::string proof) : impl_(std::make_unique<Impl>()) {
    @autoreleasepool {
        if (!valid_credentials(invite, proof)) return;
        impl_->origin = ascii(std::string(invite.origin.begin(), invite.origin.end()));
        impl_->token = ascii(invite.token);
        impl_->proof = ascii(proof);
        if (!impl_->origin || !impl_->token || !impl_->proof) return;
        NSURLSessionConfiguration *config = NSURLSessionConfiguration.ephemeralSessionConfiguration;
        config.HTTPShouldSetCookies = NO;
        config.HTTPCookieStorage = nil;
        config.URLCache = nil;
        config.URLCredentialStorage = nil;
        config.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
        config.waitsForConnectivity = NO;
        config.timeoutIntervalForRequest = 4;
        config.timeoutIntervalForResource = 12;
        config.connectionProxyDictionary = @{@"HTTPEnable": @NO, @"HTTPSEnable": @NO, @"SOCKSEnable": @NO,
                                              @"ProxyAutoConfigEnable": @NO, @"ProxyAutoDiscoveryEnable": @NO};
        NSOperationQueue *queue = [NSOperationQueue new];
        queue.maxConcurrentOperationCount = 1;
        impl_->delegate = [MundoRoomDelegate new];
        impl_->session = [NSURLSession sessionWithConfiguration:config delegate:impl_->delegate delegateQueue:queue];
    }
}

Http::~Http() = default;

Response Http::post(std::string_view action, std::string_view json, std::size_t max_bytes, CancelToken stop, ScenePresence presence) {
    @autoreleasepool {
        const auto fragment_limit = room_fragment_limit(action);
        if (!impl_->session || stop.stop_requested() || max_bytes > max_world_size ||
            json.size() > 512 || (action != "join" && action != "input" && action != "world" &&
            !fragment_limit && action != "leave" && action != "meeting" && action != "route")) return {};
        if (fragment_limit && max_bytes > *fragment_limit) max_bytes = *fragment_limit;
        const BOOL statusOnly = action == "leave" || is_usage_report(action);
        NSString *address = [NSString stringWithFormat:@"%@/room/%@", impl_->origin, ascii(action)];
        NSURL *url = [NSURL URLWithString:address];
        if (!url) return {};
        NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
        request.HTTPMethod = @"POST";
        request.HTTPShouldHandleCookies = NO;
        request.HTTPBody = [NSData dataWithBytes:json.data() length:json.size()];
        request.timeoutInterval = statusOnly ? 1 : 4;
        [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
        NSString *accept = action == "audio" ? @"audio/wav" : (action == "meeting" || action == "audio-info") ? @"text/plain" :
            (action == "route" || fragment_limit) ? @"application/octet-stream" : @"application/vnd.mundo.room-v3";
        [request setValue:accept forHTTPHeaderField:@"Accept"];
        [request setValue:@"1" forHTTPHeaderField:@"X-Mundo-Travel"];
        [request setValue:@"1" forHTTPHeaderField:@"X-Mundo-Circuit"];
        [request setValue:@"1" forHTTPHeaderField:@"X-Mundo-Splits"];
        [request setValue:@"1" forHTTPHeaderField:@"X-Mundo-Npcs"];
        [request setValue:@"1" forHTTPHeaderField:@"X-Mundo-Race-Start"];
        [request setValue:impl_->origin forHTTPHeaderField:@"Origin"];
        if (const char* value = scene_header(presence))
            [request setValue:ascii(value) forHTTPHeaderField:@"X-Mundo-Scene"];
        [request setValue:impl_->token forHTTPHeaderField:@"X-Invite"];
        [request setValue:impl_->proof forHTTPHeaderField:@"X-Seat"];

        MundoRoomTransfer *transfer = [MundoRoomTransfer new];
        transfer->limit = max_bytes;
        transfer->expectedType = statusOnly ? nil : (action == "world" ? @"application/octet-stream" : accept);
        NSURLSessionDataTask *task = [impl_->session dataTaskWithRequest:request];
        [impl_->delegate bind:task transfer:transfer];
        [task resume];

        using namespace std::chrono;
        const auto deadline = steady_clock::now() + seconds(statusOnly ? 1 : 12);
        while (!stop.stop_requested() && steady_clock::now() < deadline) {
            if (!dispatch_semaphore_wait(transfer->finished, dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC))) {
                if (!valid_room_reply_size(action,transfer->reply.status,transfer->reply.body.size())) return {};
                return std::move(transfer->reply);
            }
        }
        [impl_->delegate forget:task];
        [task cancel];
        return {};
    }
}
} // namespace mundo::room

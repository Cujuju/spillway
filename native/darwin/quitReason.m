// Node-API addon: why macOS asked the app to quit. The Dock's Quit sends a plain quit Apple Event;
// logout, restart and shutdown add a kAEQuitReason attribute. AppKit handles the event and runs
// terminate: later, when the event is no longer current, so a handler in front of AppKit's records it.
// Built universal by scripts/build-native.mjs; Node-API is ABI-stable, so no Electron headers are needed.

#import <Foundation/Foundation.h>
#include <CoreServices/CoreServices.h>

// The few Node-API declarations used (node_api.h), resolved from the host process at load.
typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef int napi_status;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
extern napi_status napi_create_string_utf8(napi_env, const char *, size_t, napi_value *);
extern napi_status napi_create_double(napi_env, double, napi_value *);
extern napi_status napi_create_object(napi_env, napi_value *);
extern napi_status napi_get_null(napi_env, napi_value *);
extern napi_status napi_get_boolean(napi_env, bool, napi_value *);
extern napi_status napi_create_function(napi_env, const char *, size_t, napi_callback, void *, napi_value *);
extern napi_status napi_set_named_property(napi_env, napi_value, const char *, napi_value);
#define NAPI_AUTO_LENGTH SIZE_MAX

static AEEventHandlerUPP appKitHandler = NULL;
static SRefCon appKitRefcon = 0;
static bool installed = false;
// The last quit event's reason and when it arrived; the main thread writes and reads both.
static const char *lastReason = NULL;
static double lastAt = 0;

static const char *reasonOf(const AppleEvent *event) {
  OSType why = 0;
  DescType type;
  Size size;
  if (AEGetAttributePtr(event, kAEQuitReason, typeEnumerated, &type, &why, sizeof why, &size) != noErr) return "quit";
  switch (why) {
    case kAELogOut:
    case kAEReallyLogOut: return "logout";
    case kAEShowRestartDialog:
    case kAERestart: return "restart";
    case kAEShowShutdownDialog:
    case kAEShutDown: return "shutdown";
    default: return "system";
  }
}

static OSErr onQuit(const AppleEvent *event, AppleEvent *reply, SRefCon refcon) {
  (void)refcon;
  lastReason = reasonOf(event);
  lastAt = [NSDate timeIntervalSinceReferenceDate];
  return appKitHandler ? appKitHandler(event, reply, appKitRefcon) : errAEEventNotHandled;
}

// install(): puts the recorder in front of AppKit's quit handler; call after app ready. True once installed.
static napi_value Install(napi_env env, napi_callback_info info) {
  (void)info;
  if (!installed && AEGetEventHandler(kCoreEventClass, kAEQuitApplication, &appKitHandler, &appKitRefcon, false) == noErr) {
    installed = AEInstallEventHandler(kCoreEventClass, kAEQuitApplication, NewAEEventHandlerUPP(onQuit), 0, false) == noErr;
  }
  napi_value out = NULL;
  napi_get_boolean(env, installed, &out);
  return out;
}

// takeQuit(): { reason, ageMs } of the quit event since the last call, or null; each event is reported once.
static napi_value TakeQuit(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value out = NULL;
  if (!lastReason) {
    napi_get_null(env, &out);
    return out;
  }
  napi_value reason = NULL, age = NULL;
  napi_create_object(env, &out);
  napi_create_string_utf8(env, lastReason, NAPI_AUTO_LENGTH, &reason);
  napi_create_double(env, ([NSDate timeIntervalSinceReferenceDate] - lastAt) * 1000, &age);
  napi_set_named_property(env, out, "reason", reason);
  napi_set_named_property(env, out, "ageMs", age);
  lastReason = NULL;
  return out;
}

static void define(napi_env env, napi_value exports, const char *name, napi_callback cb) {
  napi_value fn = NULL;
  if (napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, NULL, &fn) == 0) napi_set_named_property(env, exports, name, fn);
}

__attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  define(env, exports, "install", Install);
  define(env, exports, "takeQuit", TakeQuit);
  return exports;
}

__attribute__((visibility("default"))) int32_t node_api_module_get_api_version_v1(void) { return 8; }

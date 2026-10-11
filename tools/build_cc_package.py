#!/usr/bin/env python3
"""Package Hermes UI and the reviewed bootstrap for a guarded CC install."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess


STATUS_CODES = {
    name: index + 1
    for index, name in enumerate(
        [
            "created",
            "scheduled",
            "waiting-capture",
            "require-captured",
            "waiting-modules",
            "installed",
            "capture-failed",
            "install-failed",
            "failed",
            "disposed",
            "global-intrinsics-unavailable",
            "loaded-base-timer-module-unavailable",
            "clock-unavailable",
            "startup-preflight-or-scheduling-failed",
            "deferred-callback-failed",
            "startup-deadline",
            "startup-poll-limit",
            "initial-dispatch-deadline",
            "unexpected-driver-state",
            "diagnostic-slot-changed",
            "explicit-dispose",
            "arming",
            "armed",
            "captured",
            "finished",
            "cancelled",
            "rejected",
            "expired",
            "not-created",
            "pending-local-render",
            "initializing",
            "ready",
            "unavailable",
            "external-bindings",
            "call-limit",
            "observer-error",
            "capture-deadline",
            # Append only: captured NDSTATUS results use the earlier numeric codes.
            "runtime-changed",
            "element-guard-failed",
            "direct-ui-install-failed",
            "NDUI: renderer-failed",
            "NDUI: renderer-context",
            "NDUI: renderer-runtime",
            "NDUI: renderer-proof",
            "NDUI: base-loader",
            "NDUI: react-jsx-shape",
            "NDUI: initialization-state",
            "NDUI: local-screen-create",
            "NDUI: local-screen-shape",
            "NDUI: local-render-failed",
            "NDUI: session-dispose-failed",
            *[
                "NDUI: %s-%s" % (module, failure)
                for module in (
                    "react",
                    "jsx",
                    "view",
                    "text",
                    "button",
                    "text-input",
                    "focus-layer",
                )
                for failure in ("factory", "initialize", "cache")
            ],
            *[
                "NDUI: %s-component" % module
                for module in ("view", "text", "button", "text-input", "focus-layer")
            ],
        ]
    )
}
STATUS_FIELDS = {
    "s": "slot: 0 absent, 1 own undefined, 2 own object, 3 accessor, 4 other value",
    "p": "phase",
    "r": "reason",
    "d": "driver.phase",
    "c": "driver.capture.state",
    "q": "capture.reason; lastAttempt fallback",
    "l": "lastAttempt.phase",
    "lc": "lastAttempt.capture.state",
    "n": "polls (0..999)",
    "k": "capture.calls; lastAttempt fallback (0..999999)",
    "m": "driver.missingModules.length (0..99)",
    "u": "driver.uiInitialization",
    "g": "capture.matchStage; lastAttempt fallback (0..6)",
}
STATUS_JSX_FIELDS = {
    "s": STATUS_FIELDS["s"],
    "p": "phase",
    "r": "reason",
    "d": "driver.phase",
    "a": "driver.hook.active: 1 true, 0 false, -1 absent or not boolean",
    "x": "driver.hook.removed: 1 true, 0 false, -1 absent or not boolean",
    "c": "driver.hook.candidates (0..999999)",
    "n": "driver.hook.substitutions (0..999999)",
    "u": "driver.renderer.phase",
    "v": "driver.renderer.renders (0..999999)",
    "i": "driver.renderer.sessionInitialization",
    "h": "driver.hook.reason",
    "e": "driver.renderer.reason",
}


def status_source():
    """Only descriptors, numeric codes and an intentional bounded result error.

    No diagnostic methods, accessors, module factories, timers, logging hooks or
    network functions are invoked. Numeric JSON is assembled directly to avoid
    JSON.stringify consulting an inherited toJSON method on any source object.
    Unknown strings are reported as -1, never copied into the native message.
    """
    # The numeric JSX result is at most 63 ASCII bytes. An optional, strictly
    # symbolic session reason adds at most 59 bytes (including its delimiter).
    if max(STATUS_CODES.values()) > 99:
        raise ValueError("status codes exceed the bounded two-digit wire format")
    cases = "\n".join(
        "case %s: return %d;" % (json.dumps(name), code)
        for name, code in STATUS_CODES.items()
    )
    return (
        (
            """(function () {
var own = Object.getOwnPropertyDescriptor;
function read(object, key) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) return undefined;
  var descriptor = own(object, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function code(value) {
  if (value === undefined) return 0;
  switch (value) {
CASES
  default: return -1;
  }
}
function count(value, maximum) {
  return typeof value === 'number' && value >= 0 && value <= maximum && value % 1 === 0 ? value : -1;
}
function flag(value) {
  return value === true ? 1 : value === false ? 0 : -1;
}
var slot = own(globalThis, '__navidromeLocalMusicStatus');
var state = slot && 'value' in slot ? slot.value : undefined;
var shape = !slot ? 0 : !('value' in slot) ? 3 : state === undefined ? 1 :
  state !== null && typeof state === 'object' ? 2 : 4;
var driver = read(state, 'driver'), capture = read(driver, 'capture');
if (read(state, 'route') === 'shared-jsx') {
  var hook = read(driver, 'hook'), renderer = read(driver, 'renderer');
  var target = read(read(renderer, 'session'), 'publicResponseTarget');
  if (typeof target === 'string' && target.length <= 110 &&
      (/^(?:https?:\/\/[A-Za-z0-9.:-]+)?\/[A-Za-z0-9._/-]*$/.test(target) ||
       target === '[empty]' || target === '[unavailable]')) throw new Error('NDURL:' + target);
  var jsxMessage = 'NDJSXSTATUS:[' + shape +
    ',' + code(read(state, 'phase')) + ',' + code(read(state, 'reason')) +
    ',' + code(read(driver, 'phase')) + ',' + flag(read(hook, 'active')) +
    ',' + flag(read(hook, 'removed')) + ',' + count(read(hook, 'candidates'), 999999) +
    ',' + count(read(hook, 'substitutions'), 999999) + ',' + code(read(renderer, 'phase')) +
    ',' + count(read(renderer, 'renders'), 999999) + ',' + code(read(renderer, 'sessionInitialization')) +
    ',' + code(read(hook, 'reason')) + ',' + code(read(renderer, 'reason')) + ']';
  var sessionReason = read(renderer, 'sessionReason') || read(read(renderer, 'session'), 'loginFailureCode');
  if (typeof sessionReason === 'string' && /^ND(SESSION|NET|RNG|LOGIN|AUTH)_[A-Z0-9_]{1,48}$/.test(sessionReason))
    jsxMessage += '|' + sessionReason;
  if (jsxMessage.length > 128) throw new Error('NDJSXSTATUS:[-2]');
  throw new Error(jsxMessage);
}
var last = read(state, 'lastAttempt'), lastCapture = read(last, 'capture');
var calls = read(capture, 'calls');
if (calls === undefined) calls = read(lastCapture, 'calls');
var captureReason = read(capture, 'reason');
if (captureReason === undefined) captureReason = read(lastCapture, 'reason');
var matchStage = read(capture, 'matchStage');
if (matchStage === undefined) matchStage = read(lastCapture, 'matchStage');
var message = 'NDSTATUS:[' + shape +
  ',' + code(read(state, 'phase')) + ',' + code(read(state, 'reason')) +
  ',' + code(read(driver, 'phase')) + ',' + code(read(capture, 'state')) +
  ',' + code(captureReason) + ',' + code(read(last, 'phase')) +
  ',' + code(read(lastCapture, 'state')) + ',' + count(read(state, 'polls'), 999) +
  ',' + count(calls, 999999) + ',' + count(read(read(driver, 'missingModules'), 'length'), 99) +
  ',' + code(read(driver, 'uiInitialization')) + ',' + count(matchStage, 6) + ']';
if (message.length > 64) throw new Error('NDSTATUS:[-2]');
throw new Error(message);
})();
"""
        )
        .replace("CASES", cases)
        .encode("ascii")
    )


def failed_startup_recovery_source():
    """Retire only a failed, fully cleaned capture owned by the known startup API.

    The existing own dispose method is invoked after all initial guards. Its
    newly published snapshot must pass the same guards and match by identity
    before either global slot is deleted. Active/installed/unknown state fails.
    """
    return """(function () {
var own = Object.getOwnPropertyDescriptor, names = Object.getOwnPropertyNames;
var define = Object.defineProperty, remove = Reflect.deleteProperty, apply = Reflect.apply;
var controlName = '__navidromeLocalMusicControl', statusName = '__navidromeLocalMusicStatus';
function read(object, key) {
  if (!object || typeof object !== 'object') return undefined;
  var descriptor = own(object, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function slot(descriptor, expected) {
  return descriptor && 'value' in descriptor && descriptor.value === expected &&
    descriptor.writable === false && descriptor.enumerable === false && descriptor.configurable === true;
}
function empty(array) {
  return Array.isArray(array) && read(array, 'length') === 0;
}
function method(control, key) {
  var descriptor = own(control, key);
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'function' ?
    descriptor.value : undefined;
}
function sameDataDescriptor(before, after) {
  return before && after && 'value' in before && 'value' in after &&
    before.value === after.value && before.writable === after.writable &&
    before.enumerable === after.enumerable && before.configurable === after.configurable &&
    before.get === after.get && before.set === after.set;
}
function cleanupFailure(snapshot) {
  var schema = snapshot && own(snapshot, 'schema');
  var phase = snapshot && own(snapshot, 'phase');
  var driver = read(snapshot, 'driver'), last = read(snapshot, 'lastAttempt');
  var rollback = read(driver, 'lastRollback'), captureRollback = read(driver, 'lastCaptureRollback');
  var capture = read(last, 'capture'), captureState = read(capture, 'state');
  if (!(schema && 'value' in schema && schema.value === 1)) return 'schema';
  if (!(phase && 'value' in phase && phase.value === 'failed')) return 'phase';
  if (read(snapshot, 'reason') !== 'capture-failed') return 'reason';
  if (!empty(read(snapshot, 'cleanupErrors'))) return 'cleanupErrors';
  if (read(driver, 'phase') !== 'disposed') return 'driver.phase';
  if (read(driver, 'capture') !== undefined) return 'driver.capture';
  if (read(driver, 'session') !== undefined) return 'driver.session';
  if (read(driver, 'entryRoute') !== undefined) return 'driver.entryRoute';
  if (read(driver, 'uiInitialization') !== 'not-created') return 'driver.uiInitialization';
  if (read(driver, 'sessionInitialization') !== 'not-created') return 'driver.sessionInitialization';
  if (!empty(read(driver, 'missingModules'))) return 'driver.missingModules';
  if (!empty(read(rollback, 'conflicts'))) return 'lastRollback.conflicts';
  if (!empty(read(rollback, 'restored'))) return 'lastRollback.restored';
  if (!empty(read(captureRollback, 'conflicts'))) return 'lastCaptureRollback.conflicts';
  if (read(captureRollback, 'state') !== captureState) return 'lastCaptureRollback.state';
  if (read(last, 'phase') !== 'capture-failed') return 'lastAttempt.phase';
  if (!empty(read(capture, 'conflicts'))) return 'lastAttempt.capture.conflicts';
  if (!(captureState === 'rejected' || captureState === 'expired' || captureState === 'cancelled')) return 'lastAttempt.capture.state';
  return null;
}
var beforeControl = own(globalThis, controlName), beforeStatus = own(globalThis, statusName);
var control = beforeControl && 'value' in beforeControl ? beforeControl.value : undefined;
var snapshot = beforeStatus && 'value' in beforeStatus ? beforeStatus.value : undefined;
if (!control || typeof control !== 'object' || !slot(beforeControl, control)) throw new Error('NDRECOVER: control-slot');
if (!snapshot || typeof snapshot !== 'object' || !slot(beforeStatus, snapshot)) throw new Error('NDRECOVER: status-slot');
var keys = names(control), dispose = method(control, 'dispose'), status = method(control, 'status');
var disposeDescriptor = own(control, 'dispose'), statusDescriptor = own(control, 'status');
if (keys.length !== 2) throw new Error('NDRECOVER: control-keys');
if (!dispose) throw new Error('NDRECOVER: dispose-shape');
if (!status) throw new Error('NDRECOVER: status-shape');
var beforeFailure = cleanupFailure(snapshot);
if (beforeFailure) throw new Error('NDRECOVER: before/' + beforeFailure);
if (!slot(own(globalThis, controlName), control) || !slot(own(globalThis, statusName), snapshot))
  throw new Error('NDRECOVER: initial-identity-changed');
if (!sameDataDescriptor(disposeDescriptor, own(control, 'dispose')) ||
    !sameDataDescriptor(statusDescriptor, own(control, 'status')))
  throw new Error('NDRECOVER: initial-method-descriptor-changed');
var finalSnapshot = apply(dispose, control, []);
var finalControl = own(globalThis, controlName), finalStatus = own(globalThis, statusName);
if (!slot(finalControl, control)) throw new Error('NDRECOVER: final/control-identity');
if (!slot(finalStatus, finalSnapshot)) throw new Error('NDRECOVER: final/status-identity');
var finalFailure = cleanupFailure(finalSnapshot);
if (finalFailure) throw new Error('NDRECOVER: final/' + finalFailure);
if (!sameDataDescriptor(disposeDescriptor, own(control, 'dispose'))) throw new Error('NDRECOVER: final/dispose-identity');
if (!sameDataDescriptor(statusDescriptor, own(control, 'status'))) throw new Error('NDRECOVER: final/status-method-identity');
if (!slot(own(globalThis, controlName), control) || !slot(own(globalThis, statusName), finalSnapshot))
  throw new Error('NDRECOVER: delete-identity-changed');
if (!remove(globalThis, controlName)) throw new Error('NDRECOVER: control-delete');
if (!slot(own(globalThis, statusName), finalSnapshot) || !remove(globalThis, statusName)) {
  if (!own(globalThis, controlName) && slot(own(globalThis, statusName), finalSnapshot))
    define(globalThis, controlName, finalControl);
  throw new Error('NDRECOVER: status-delete');
}
if (own(globalThis, controlName) || own(globalThis, statusName)) throw new Error('NDRECOVER: slots-reappeared');
})();
"""


def direct_startup_replacement_source():
    """Retire our direct JSX entry only while its session is absent or idle.

    Refresh the authenticated own status method because login can change the
    session without publishing a renderer snapshot. A ready session must expose
    pending=false explicitly; legacy snapshots without that proof are rejected.
    Disposal and full rollback must be confirmed before deleting either slot.
    """
    return """(function () {
var own = Object.getOwnPropertyDescriptor, names = Object.getOwnPropertyNames;
var symbols = Object.getOwnPropertySymbols, define = Object.defineProperty;
var remove = Reflect.deleteProperty, apply = Reflect.apply;
var controlName = '__navidromeLocalMusicControl', statusName = '__navidromeLocalMusicStatus';
function read(object, key) {
  if (!object || typeof object !== 'object') return undefined;
  var descriptor = own(object, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function slot(descriptor, expected) {
  return descriptor && 'value' in descriptor && descriptor.value === expected &&
    descriptor.writable === false && descriptor.enumerable === false && descriptor.configurable === true;
}
function sameDataDescriptor(before, after) {
  return before && after && 'value' in before && 'value' in after &&
    before.value === after.value && before.writable === after.writable &&
    before.enumerable === after.enumerable && before.configurable === after.configurable &&
    before.get === after.get && before.set === after.set;
}
function empty(array) {
  return Array.isArray(array) && read(array, 'length') === 0;
}
function rollbackClear(rollback) {
  return rollback !== undefined && empty(read(rollback, 'conflicts'));
}
function sessionFailure(renderer) {
  var phase = read(renderer, 'phase'), initialization = read(renderer, 'sessionInitialization');
  var session = read(renderer, 'session');
  if (!(phase === 'ready' || phase === 'created' || phase === 'disposed' || phase === 'failed'))
    return 'renderer-phase';
  if (initialization === 'unavailable' || initialization === 'not-created')
    return session === undefined ? null : 'unexpected-session';
  if (initialization === 'disposed') {
    if (session === undefined) return null;
    if (read(session, 'disposed') !== true || read(session, 'ownsSession') !== true ||
        read(session, 'runtime') !== 'base_dll' || read(session, 'pending') !== false)
      return 'retained-session-disposal';
    return playbackFailure(renderer);
  }
  if (initialization !== 'ready' || phase !== 'ready') return 'session-initialization';
  if (read(session, 'ownsSession') !== true || read(session, 'runtime') !== 'base_dll' ||
      read(session, 'disposed') !== false) return 'session-owner';
  if (read(session, 'state') !== 'disconnected') return 'session-not-disconnected';
  if (read(session, 'pending') !== false) return 'session-pending-unconfirmed';
  return null;
}
function playbackFailure(renderer) {
  var available = read(renderer, 'playbackAvailable'), playback = read(renderer, 'playback');
  if (available === false && playback === undefined) return null;
  if (available !== true && available !== false) return 'audio-availability';
  var session = read(renderer, 'session');
  if (session !== undefined && read(session, 'playback') !== playback) return 'audio-session-mirror';
  if (read(playback, 'available') !== available) return 'audio-availability-mirror';
  if (available === true && read(playback, 'stopConfirmed') !== true) return 'audio-stop-unconfirmed';
  if (!playback || read(playback, 'phase') !== 'idle' || read(playback, 'pending') !== false ||
      read(playback, 'stopPending') !== false || read(playback, 'workerActive') !== false ||
      read(playback, 'closeConfirmed') !== true) return 'audio-not-stopped';
  return null;
}
function initialFailure(snapshot) {
  var phase = read(snapshot, 'phase'), driver = read(snapshot, 'driver');
  var hook = read(driver, 'hook'), renderer = read(driver, 'renderer');
  if (read(snapshot, 'schema') !== 1 || read(snapshot, 'route') !== 'shared-jsx') return 'route-schema';
  if (!(phase === 'installed' || phase === 'failed')) return 'phase';
  if (read(driver, 'phase') !== phase || read(driver, 'entryRoute') !== 'shared-jsx') return 'driver-route';
  if (!empty(read(snapshot, 'cleanupErrors'))) return 'cleanup-errors';
  if (!empty(read(hook, 'conflicts'))) return 'hook-conflicts';
  var active = read(hook, 'active'), removed = read(hook, 'removed');
  if (!((active === true && removed === false) || (active === false && removed === true))) return 'hook-state';
  if (phase === 'failed' && (active !== false || removed !== true)) return 'failed-hook-active';
  var rollback = read(driver, 'lastRollback'), hookRollback = read(hook, 'lastRollback');
  if (rollback !== undefined && !rollbackClear(rollback)) return 'rollback-conflicts';
  if (hookRollback !== undefined && !rollbackClear(hookRollback)) return 'hook-rollback-conflicts';
  if (removed === true && (!rollbackClear(rollback) || !rollbackClear(hookRollback))) return 'rollback-unconfirmed';
  if (read(renderer, 'runtime') !== 'base_dll') return 'renderer-owner';
  var audioProblem = playbackFailure(renderer);
  if (audioProblem) return audioProblem;
  if (read(driver, 'uiInitialization') !== read(renderer, 'phase') ||
      read(driver, 'sessionInitialization') !== read(renderer, 'sessionInitialization')) return 'renderer-mirror';
  return sessionFailure(renderer);
}
function finalFailure(snapshot, initialPhase) {
  var driver = read(snapshot, 'driver'), hook = read(driver, 'hook'), renderer = read(driver, 'renderer');
  var phase = read(snapshot, 'phase');
  if (read(snapshot, 'schema') !== 1 || read(snapshot, 'route') !== 'shared-jsx') return 'route-schema';
  if (!(phase === 'disposed' || (initialPhase === 'failed' && phase === 'failed'))) return 'phase';
  if (read(driver, 'phase') !== phase || read(driver, 'entryRoute') !== 'shared-jsx') return 'driver-route';
  if (!empty(read(snapshot, 'cleanupErrors'))) return 'cleanup-errors';
  if (read(hook, 'active') !== false || read(hook, 'removed') !== true) return 'hook-state';
  if (!empty(read(hook, 'conflicts'))) return 'hook-conflicts';
  if (!rollbackClear(read(driver, 'lastRollback'))) return 'rollback-conflicts';
  if (!rollbackClear(read(hook, 'lastRollback'))) return 'hook-rollback-conflicts';
  if (read(renderer, 'phase') !== 'disposed' || read(renderer, 'runtime') !== 'base_dll') return 'renderer-disposal';
  var audioProblem = playbackFailure(renderer);
  if (audioProblem) return audioProblem;
  if (read(renderer, 'sessionInitialization') !== 'disposed') return 'session-disposal';
  var session = read(renderer, 'session');
  if (session !== undefined && (read(session, 'disposed') !== true || read(session, 'ownsSession') !== true ||
      read(session, 'runtime') !== 'base_dll' || read(session, 'pending') !== false)) return 'session-disposal';
  if (read(renderer, 'reason') === 'NDUI: session-dispose-failed' ||
      read(renderer, 'failureReason') === 'NDUI: session-dispose-failed') return 'session-dispose-failed';
  if (read(driver, 'uiInitialization') !== 'disposed' || read(driver, 'sessionInitialization') !== 'disposed')
    return 'driver-disposal';
  return null;
}
var beforeControl = own(globalThis, controlName), beforeStatus = own(globalThis, statusName);
var control = beforeControl && 'value' in beforeControl ? beforeControl.value : undefined;
var snapshot = beforeStatus && 'value' in beforeStatus ? beforeStatus.value : undefined;
if (!control || typeof control !== 'object' || !slot(beforeControl, control)) throw new Error('NDREPLACE: control-slot');
if (!snapshot || typeof snapshot !== 'object' || !slot(beforeStatus, snapshot)) throw new Error('NDREPLACE: status-slot');
var keys = names(control), disposeDescriptor = own(control, 'dispose'), statusDescriptor = own(control, 'status');
var stopDescriptor = own(control, 'stopPlayback');
if (!(keys.length === 2 && !stopDescriptor) && !(keys.length === 3 && stopDescriptor &&
    'value' in stopDescriptor && typeof stopDescriptor.value === 'function'))
  throw new Error('NDREPLACE: control-keys');
if (typeof symbols !== 'function' || symbols(control).length !== 0)
  throw new Error('NDREPLACE: control-keys');
if (!disposeDescriptor || !('value' in disposeDescriptor) || typeof disposeDescriptor.value !== 'function')
  throw new Error('NDREPLACE: dispose-shape');
if (!statusDescriptor || !('value' in statusDescriptor) || typeof statusDescriptor.value !== 'function')
  throw new Error('NDREPLACE: status-shape');
var initialProblem = initialFailure(snapshot);
if (initialProblem) throw new Error('NDREPLACE: before-' + initialProblem);
function identities(expectedStatus) {
  return slot(own(globalThis, controlName), control) && slot(own(globalThis, statusName), expectedStatus) &&
    sameDataDescriptor(disposeDescriptor, own(control, 'dispose')) &&
    sameDataDescriptor(statusDescriptor, own(control, 'status')) &&
    (stopDescriptor ? sameDataDescriptor(stopDescriptor, own(control, 'stopPlayback')) : !own(control, 'stopPlayback'));
}
if (!identities(snapshot)) throw new Error('NDREPLACE: initial-identity-changed');
var refreshed;
try { refreshed = apply(statusDescriptor.value, control, []); }
catch { throw new Error('NDREPLACE: status-refresh-failed'); }
if (!identities(refreshed)) throw new Error('NDREPLACE: refresh-identity-changed');
initialProblem = initialFailure(refreshed);
if (initialProblem) throw new Error('NDREPLACE: refresh-' + initialProblem);
var initialPhase = read(refreshed, 'phase'), finalSnapshot;
try { finalSnapshot = apply(disposeDescriptor.value, control, []); }
catch { throw new Error('NDREPLACE: dispose-failed'); }
if (!identities(finalSnapshot)) throw new Error('NDREPLACE: final-identity-changed');
var finalProblem = finalFailure(finalSnapshot, initialPhase);
if (finalProblem) throw new Error('NDREPLACE: final-' + finalProblem);
var finalControl = own(globalThis, controlName);
if (!identities(finalSnapshot)) throw new Error('NDREPLACE: delete-identity-changed');
if (!remove(globalThis, controlName)) throw new Error('NDREPLACE: control-delete');
if (!slot(own(globalThis, statusName), finalSnapshot) || !remove(globalThis, statusName)) {
  if (!own(globalThis, controlName) && slot(own(globalThis, statusName), finalSnapshot))
    define(globalThis, controlName, finalControl);
  throw new Error('NDREPLACE: status-delete');
}
if (own(globalThis, controlName) || own(globalThis, statusName)) throw new Error('NDREPLACE: slots-reappeared');
})();
"""


def sha(data):
    return hashlib.sha256(data).hexdigest()


def hbc(data):
    if len(data) < 128 or struct.unpack_from("<QI", data) != (0x1F1903C103BC1FC6, 89):
        raise ValueError("Expected Hermes v89 bytecode")
    if hashlib.sha1(data[:-20]).digest() != data[-20:]:
        raise ValueError("Invalid compiler output footer")


def sections(path):
    data = path.read_bytes()
    if data[:6] != b"\x7fELF\x02\x01":
        raise ValueError("Expected ELF64 little endian")
    if (
        struct.unpack_from("<H", data, 16)[0] != 2
        or struct.unpack_from("<H", data, 18)[0] != 62
    ):
        raise ValueError("Expected static x86-64 executable image")
    if struct.unpack_from("<Q", data, 24)[0] != 0:
        raise ValueError("Stub entry must be exactly zero")
    offset = struct.unpack_from("<Q", data, 40)[0]
    stride, count, names_index = struct.unpack_from("<HHH", data, 58)
    if (
        stride != 64
        or not 0 < names_index < count
        or offset + count * stride > len(data)
    ):
        raise ValueError("Invalid section table")
    raw = [
        struct.unpack_from("<IIQQQQIIQQ", data, offset + i * stride)
        for i in range(count)
    ]
    n = raw[names_index]
    names = data[n[4] : n[4] + n[5]]
    result = {}
    for item in raw:
        name = names[item[0] :].split(b"\0", 1)[0].decode("ascii")
        if item[1] in (4, 9) and item[5]:
            raise ValueError("Unapplied relocations in stub")
        if item[4] + item[5] > len(data) and item[1] != 8:
            raise ValueError("Section extends outside image")
        result[name] = {
            "address": item[3],
            "size": item[5],
            "data": data[item[4] : item[4] + item[5]],
        }
    if result[".text"]["address"] != 0 or not 0 < result[".text"]["size"] < 0x4000:
        raise ValueError("Unexpected stub code range")
    if (
        result[".nd_state"]["address"] != 0x4000
        or result[".nd_state"]["size"] >= 0x4000
    ):
        raise ValueError("Unexpected stub state range")
    for name, item in result.items():
        if name in (".got", ".dynamic", ".dynsym", ".rela.dyn") and item["size"]:
            raise ValueError("Stub still depends on dynamic loader metadata")
    return result


def array(name, data):
    return (
        "static const unsigned char "
        + name
        + "[] = {\n"
        + "\n".join(
            "    " + ",".join("0x%02x" % v for v in data[i : i + 16]) + ","
            for i in range(0, len(data), 16)
        )
        + "\n};\n"
    )


def reviewed_barrier(root, stub):
    """Bind readiness to the exact statically reviewed sources and ELF image."""
    path = root / "tools/CC_BARRIER_REVIEW.json"
    review = json.loads(path.read_text())
    if (
        review.get("schema") != 1
        or review.get("review") != "static-source-assembly-cfi-lsda"
    ):
        raise ValueError("Unrecognized native barrier review")
    for name, digest in review["files"].items():
        if sha((root / name).read_bytes()) != digest:
            raise ValueError("Reviewed barrier changed: " + name)
    if (
        sha(stub[".text"]["data"]) != review["codeSha256"]
        or stub[".nd_state"]["size"] != 0x438
    ):
        raise ValueError("Reviewed native layout changed")
    inspection = json.loads((root / review["inspection"]).read_text())
    if (
        inspection["image"]["codeSha256"] != review["codeSha256"]
        or len(inspection["fdes"]) != 5
    ):
        raise ValueError("Reviewed unwind metadata changed")
    if any(c["fdeEncoding"] != 0x1B for c in inspection["cies"]):
        raise ValueError("Unexpected native FDE encoding")
    return {
        "path": str(path.relative_to(root)),
        "sha256": sha(path.read_bytes()),
        "kind": review["review"],
        "runtimeVerified": False,
    }


def automatic_existing_source():
    """A second load preserves an intact owned card, including its audio ledger."""
    return """var prior = Object.getOwnPropertyDescriptor(globalThis, '__navidromeLocalMusicControl');
if (prior) {
  function read(o,k) { var d=o && Object.getOwnPropertyDescriptor(o,k); return d && 'value' in d ? d.value : undefined; }
  var c=read(prior,'value');
  if (prior.writable !== false || prior.enumerable !== false || prior.configurable !== true ||
      !c || !Object.isFrozen(c) || typeof read(c,'status') !== 'function' || typeof read(c,'dispose') !== 'function')
    throw new Error('NDAUTO: existing-controller-conflict');
  var v=c.status(), d=read(v,'driver'), h=read(d,'hook'), r=read(d,'renderer'), e=read(v,'cleanupErrors'), conflicts=read(h,'conflicts');
  if (read(v,'schema') !== 1 || read(v,'route') !== 'shared-jsx' || read(v,'phase') !== 'installed' ||
      read(d,'phase') !== 'installed' || read(d,'entryRoute') !== 'shared-jsx' ||
      read(h,'active') !== true || read(h,'removed') !== false ||
      !Array.isArray(e) || e.length !== 0 || !Array.isArray(conflicts) || conflicts.length !== 0 ||
      read(r,'runtime') !== 'base_dll' || !['created','ready'].includes(read(r,'phase')) ||
      read(d,'uiInitialization') !== read(r,'phase'))
    throw new Error('NDAUTO: existing-installation-conflict');
  return;
}
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--identity", type=Path)
    target.add_argument(
        "--auto-detect",
        action="store_true",
        help="Discover and pin the current CC identity at load time; no session capture input",
    )
    parser.add_argument("--package-id", required=True)
    parser.add_argument(
        "--operation",
        choices=("start", "status"),
        default="start",
        help="start installs the UI; status reads published data via an intentional NDSTATUS exception",
    )
    parser.add_argument(
        "--reviewed-barrier",
        action="store_true",
        help="Enable only the byte-identical barrier recorded in CC_BARRIER_REVIEW.json",
    )
    parser.add_argument(
        "--recover-undefined-startup-status",
        action="store_true",
        help="Recover the exact undefined diagnostic left by the failed first startup",
    )
    parser.add_argument(
        "--recover-failed-startup",
        action="store_true",
        help="Retire only a confirmed capture-failed startup whose disposal and rollback have no conflicts",
    )
    parser.add_argument(
        "--replace-direct-startup",
        action="store_true",
        help="Replace our direct JSX startup only after idle-session and complete disposal/rollback guards",
    )
    parser.add_argument(
        "--audio-token-file",
        type=Path,
        help="Private 64-hex token for the local audio service; embedded only in the executable package",
    )
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,48}", args.package_id):
        parser.error("package-id must be 1–48 ASCII letters/digits/underscore/hyphen")
    recovery_count = sum(
        (
            args.recover_undefined_startup_status,
            args.recover_failed_startup,
            args.replace_direct_startup,
        )
    )
    if args.operation == "status" and recovery_count:
        parser.error("status cannot clean or modify the existing diagnostic slot")
    if recovery_count > 1:
        parser.error("Choose exactly one startup recovery policy")
    root = Path(__file__).resolve().parent.parent
    out = root / "build"
    audio_config = None
    if args.audio_token_file:
        if args.operation != "start":
            parser.error("audio-token-file is only valid for start")
        token = args.audio_token_file.read_text().strip()
        if not re.fullmatch(r"[0-9a-f]{64}", token):
            parser.error(
                "audio-token-file must contain exactly 64 lowercase hex characters"
            )
        audio_config = {"token": token}
        # The compiler also writes a private bytecode file. Set creation modes
        # before any secret-bearing write; umask alone does not tighten an old
        # output's existing permissions when it is truncated and rewritten.
        os.umask(0o077)
        for name in (
            "navidrome-cc-entry.js",
            "navidrome-cc-entry.hbc",
            "cc-install-payload.h",
        ):
            destination = out / name
            if destination.exists():
                destination.chmod(0o600)
    profile = json.loads((out / "navidrome-bootstrap.profile.json").read_text())
    if audio_config is not None and profile.get("entry") != "ui/direct-music-entry.mjs":
        parser.error("audio control requires a UI build from ui/direct-music-entry.mjs")
    bundled = b""
    if args.operation == "start":
        for name, digest in profile["sources"].items():
            if sha((root / name).read_bytes()) != digest:
                raise ValueError("UI source changed since build: " + name)
        bundled = (out / "navidrome-bootstrap.js").read_bytes()
        if sha(bundled) != profile["outputs"]["navidrome-bootstrap.js"]["sha256"]:
            raise ValueError("UI source bundle changed")
        if b"startLocalMusic" not in bundled:
            raise ValueError("The UI bundle does not export the explicit startup API")
    if args.auto_detect:
        identity = {
            "pid": 0,
            "executor": 0,
            "runtime": 0,
            "appInstanceId": 0,
            "jsThread": 0,
        }
    else:
        route = json.loads(args.identity.read_text())
        if (
            route.get("captureProfile") != "cc-executor-route-13200006-v3"
            or not route.get("complete")
            or route.get("failure")
        ):
            raise ValueError("Requires complete v3 CC identity capture")
        if route["pid"] != route["finalPid"] or route["firmware"] != "0x13200006":
            raise ValueError("Capture generation is inconsistent")
        for key in (
            "initialCredentialScope",
            "finalCredentialScope",
            "mapCredentialScope",
        ):
            if route[key].get("restored") is not True:
                raise ValueError("Capture credentials were not restored")
        if not all(
            m["guardAccepted"] and m["identityUnchanged"] for m in route["modules"]
        ):
            raise ValueError("Capture module guard failed")
        reads = {r["name"]: r for r in route["reads"]}
        if not all(
            r["stable"] and not r["initialError"] and not r["finalError"]
            for r in reads.values()
        ):
            raise ValueError("Identity readback was unstable")

        def u64(name):
            b = bytes.fromhex(reads[name]["initialHex"])
            if len(b) != 8:
                raise ValueError("Unexpected pointer/ID width")
            return int.from_bytes(b, "little")

        def text16(name):
            return (
                bytes.fromhex(reads[name]["initialHex"])
                .decode("utf-16-le")
                .rstrip("\0")
            )

        if (
            text16("application_name_utf16le") != "rnps-control-center"
            or text16("application_bundle_utf16le")
            != "/system_ex/rnps/apps/NPXS40003/application.ps.bundle"
        ):
            raise ValueError("Capture is not the expected Control Center application")
        identity = {
            "pid": route["pid"],
            "executor": u64("executor_native"),
            "runtime": u64("native_runtime_pointer"),
            "appInstanceId": u64("native_app_instance_id_i64"),
            "jsThread": u64("executor_js_thread"),
        }
    proof = {
        "firmware": 0x13200006,
        "titleId": "NPXS40003",
        "isolatedRealm": True,
        "phase": "application-running",
        "executorIdentity": (
            "native-autodetected-current-cc"
            if args.auto_detect
            else "pid%d-cc-%x-%x"
            % (identity["pid"], identity["executor"], identity["appInstanceId"])
        ),
        "bundleSha256": "8a5ad941d8ca0dedad99df7c1f09c5fc36ce9752a5d0954b92401d24aad8990e",
        "baseDllSha256": "924e90c2257cd6b0a1e895dc45abf4882ddd3504a6c32964ff74d259b975092c",
    }
    # This claim is packaged intent, not authorization by a JSON value. The
    # native installer must repeat the identity/file guards before publication;
    # the JS driver additionally checks this realm's actual application loaders.
    prefix = """(function () {
if (typeof globalThis !== 'object' || !globalThis) throw new Error('CC global object unavailable');
"""
    if args.auto_detect and not recovery_count:
        prefix += automatic_existing_source()
    if args.recover_failed_startup:
        prefix += failed_startup_recovery_source()
    if args.replace_direct_startup:
        prefix += direct_startup_replacement_source()
    prefix += "if (Object.getOwnPropertyDescriptor(globalThis, '__navidromeLocalMusicControl')) throw new Error('Local music control is already owned');\n"
    if args.recover_undefined_startup_status:
        prefix += """var legacy = Object.getOwnPropertyDescriptor(globalThis, '__navidromeLocalMusicStatus');
if (legacy && 'value' in legacy && legacy.value === undefined && legacy.writable === false && legacy.enumerable === false && legacy.configurable === true) {
  if (!Reflect.deleteProperty(globalThis, '__navidromeLocalMusicStatus')) throw new Error('Legacy startup diagnostic cleanup failed');
}
"""
    suffix = """
var controller = NavidromePS5.startLocalMusic({globalObject: globalThis, contextProof: PROOF, audioConfig: AUDIO_CONFIG});
if (!controller || typeof controller.status !== 'function' || typeof controller.dispose !== 'function') throw new Error('Navidrome startup: controller-unavailable');
var startup = controller.status();
if (!startup || typeof startup.phase !== 'string') throw new Error('Navidrome startup: status-unavailable');
function disposeFailedStartup() {
  var last = controller.dispose();
  var slot = Object.getOwnPropertyDescriptor(globalThis, '__navidromeLocalMusicStatus');
  if (slot && 'value' in slot && slot.value === last && slot.writable === false && slot.enumerable === false && slot.configurable === true) {
    Reflect.deleteProperty(globalThis, '__navidromeLocalMusicStatus');
  }
}
if (startup.phase === 'failed') { var failure = startup.reason; disposeFailedStartup(); throw new Error('Navidrome startup: ' + failure); }
try { Object.defineProperty(globalThis, '__navidromeLocalMusicControl', {value: controller, writable: false, enumerable: false, configurable: true}); } catch (error) { disposeFailedStartup(); throw error; }
})();
""".replace(
        "PROOF", json.dumps(proof, separators=(",", ":"))
    ).replace(
        "AUDIO_CONFIG", json.dumps(audio_config, separators=(",", ":"))
    )
    source = (
        status_source()
        if args.operation == "status"
        else prefix.encode("ascii") + bundled + suffix.encode("ascii")
    )
    entry = out / "navidrome-cc-entry.js"
    bytecode = out / "navidrome-cc-entry.hbc"
    entry.write_bytes(source)
    if audio_config:
        entry.chmod(0o600)
    compiler = Path(profile["tools"]["hermesc"]["path"])
    if sha(compiler.read_bytes()) != profile["tools"]["hermesc"]["sha256"]:
        raise ValueError("Hermes compiler identity changed")
    subprocess.run(
        [str(compiler), "-O", "-emit-binary", "-out", bytecode.name, entry.name],
        cwd=out,
        check=True,
    )
    hbc_data = bytecode.read_bytes()
    hbc(hbc_data)
    stub = sections(out / "cc-bootstrap-stub.elf")
    code = stub[".text"]["data"]
    # Eleven bytecode pages plus the two bootstrap pages fit the bounded tracer.
    if len(hbc_data) > 11 * 16384:
        raise ValueError(
            "UI bytecode exceeds the installer's initialized mapping capacity"
        )
    barrier = reviewed_barrier(root, stub) if args.reviewed_barrier else None
    configure_http_audio = (
        args.operation == "start" and audio_config is not None and not recovery_count
    )
    meta = {
        "schema": 1,
        "packageId": args.package_id,
        "firmware": "0x13200006",
        "operation": args.operation,
        "includesUiBundle": args.operation == "start",
        "audioControlConfigured": audio_config is not None,
        "configureHttpAudio": configure_http_audio,
        "identity": identity,
        "contextProof": proof,
        "stubSha256": sha(code),
        "stubCodeBytes": len(code),
        "hbcSha256": sha(hbc_data),
        "hbcBytes": len(hbc_data),
        "cppBarrierReady": barrier is not None,
        "barrierReview": barrier,
        "recoverUndefinedStartupStatus": args.recover_undefined_startup_status,
        "recoverFailedStartup": args.recover_failed_startup,
        "replaceDirectStartup": args.replace_direct_startup,
        "identityMode": "automatic-runtime" if args.auto_detect else "captured-session",
        "identityEvidenceSha256": (
            None if args.auto_detect else sha(args.identity.read_bytes())
        ),
        "entrySourceSha256": sha(source),
        "uiBuildProfileSha256": sha(
            (out / "navidrome-bootstrap.profile.json").read_bytes()
        ),
        "status": (
            "compiled-ready-for-guarded-publication"
            if barrier
            else "compiled-publication-disabled"
        ),
    }
    if args.operation == "status":
        meta["observation"] = {
            "source": "last published own-data diagnostic snapshot; no refresh",
            "channel": "intentional Error NDSTATUS or NDJSXSTATUS in native exception message; not a startup failure",
            "messageLimitBytes": 128,
            "nativeMessageCapacityBytes": 191,
            "format": "NDSTATUS:[s,p,r,d,c,q,l,lc,n,k,m,u,g]; [-2] means output overflow",
            "fieldOrder": list(STATUS_FIELDS),
            "fields": STATUS_FIELDS,
            "directRoute": {
                "selector": "own-data route equals shared-jsx",
                "format": "NDJSXSTATUS:[s,p,r,d,a,x,c,n,u,v,i,h,e][|SESSION_REASON]; [-2] means output overflow",
                "fieldOrder": list(STATUS_JSX_FIELDS),
                "fields": STATUS_JSX_FIELDS,
                "maximumMessageBytes": 122,
                "messageLimitBytes": 128,
                "sessionReason": {
                    "source": "own-data driver.renderer.sessionReason",
                    "pattern": "^ND(SESSION|NET|RNG)_[A-Z0-9_]{1,48}$",
                    "maximumBytes": 58,
                    "omittedUnlessMatched": True,
                },
                "booleanCodes": {
                    "1": "true",
                    "0": "false",
                    "-1": "absent or not boolean",
                },
                "counterCodes": {"-1": "absent, non-integer or out of bounds"},
            },
            "valueCodes": {
                "0": "absent or undefined",
                "-1": "unknown value",
                **{str(code): name for name, code in STATUS_CODES.items()},
            },
            "limitations": [
                "Only the first 191 native message bytes are retained, including native prefix.",
                "No status method, source accessor, logging hook, UI factory or network operation is invoked.",
                "Counters and phases reflect the last published snapshot; this observation never refreshes it.",
                "The native observation package still uses a temporary hook and a resident allocation.",
            ],
        }
    digest = sha(json.dumps(meta, sort_keys=True, separators=(",", ":")).encode())
    meta["packageSha256"] = digest
    constants = {
        "ND_CC_AUTODETECT_IDENTITY": "1" if args.auto_detect else "0",
        "ND_CC_CONFIGURE_HTTP_AUDIO": "1" if configure_http_audio else "0",
        "ND_CC_PACKAGE_SCHEMA": "1",
        "ND_CC_EXPECTED_FIRMWARE": "UINT32_C(0x13200006)",
        "ND_CC_EXPECTED_PID": str(identity["pid"]),
        "ND_CC_PACKAGE_ID": json.dumps(args.package_id),
        "ND_CC_PACKAGE_OPERATION": json.dumps(args.operation),
        "ND_CC_PACKAGE_SHA256": json.dumps(digest),
        "ND_CC_STUB_SHA256": json.dumps(sha(code)),
        "ND_CC_HBC_SHA256": json.dumps(sha(hbc_data)),
        "ND_CC_CPP_BARRIER_READY": "1" if barrier else "0",
        "ND_CC_STUB_CODE_BYTES": str(len(code)),
        "ND_CC_EXPECTED_EXECUTOR": "UINT64_C(0x%x)" % identity["executor"],
        "ND_CC_EXPECTED_RUNTIME": "UINT64_C(0x%x)" % identity["runtime"],
        "ND_CC_EXPECTED_APP_INSTANCE_ID": "UINT64_C(0x%x)" % identity["appInstanceId"],
        "ND_CC_EXPECTED_JS_THREAD": "UINT64_C(0x%x)" % identity["jsThread"],
    }
    header = "/* Generated by tools/build_cc_package.py. No deployment. */\n#include <stdint.h>\n"
    header += "\n".join("#define %s %s" % pair for pair in constants.items()) + "\n"
    header += array("nd_cc_stub_image", code) + array("nd_cc_hbc_image", hbc_data)
    (out / "cc-install-payload.h").write_text(header)
    if audio_config:
        bytecode.chmod(0o600)
        (out / "cc-install-payload.h").chmod(0o600)
    (out / "cc-install-package.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(
        json.dumps(
            {
                k: meta[k]
                for k in (
                    "packageId",
                    "hbcBytes",
                    "stubCodeBytes",
                    "packageSha256",
                    "status",
                )
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Exercise real installer identity policies and the generated repeat-load guard."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "package", ROOT / "tools/build_cc_package.py"
)
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class AutomaticIdentityTests(unittest.TestCase):
    def test_live_identity_is_portable_but_transaction_is_pinned(self):
        source = (ROOT / "tools/cc_installer.c").read_text()
        policies = source[
            source.index("static int package_identity(") : source.index(
                "static int write_and_verify("
            )
        ]
        harness = r"""
#include <assert.h>
#include <string.h>
#include "cc_executor_guard.h"
#define ND_CC_EXPECTED_FIRMWARE 0x13200006U
#define ND_CC_EXPECTED_PID 60
#define ND_CC_EXPECTED_EXECUTOR 0x10000U
#define ND_CC_EXPECTED_RUNTIME 0x20000U
#define ND_CC_EXPECTED_APP_INSTANCE_ID 77U
#define ND_CC_EXPECTED_JS_THREAD 0x30000U
POLICIES
int main(void) {
 struct nd_cc_identity a={0}; a.complete=a.stable=a.credentials_restored=a.backend=1;
 a.initial_pid=a.final_pid=60; a.firmware=ND_CC_EXPECTED_FIRMWARE;
 a.native_executor=0x10000; a.runtime=0x20000; a.app_instance_id=77; a.js_thread=0x30000;
 for(int n=0;n<4;n++){a.modules[n].guard_accepted=a.modules[n].identity_unchanged=1; a.modules[n].base=0x40000+n*0x4000; a.modules[n].handle=n+1;}
 assert(package_identity(&a)); assert(same_identity(&a,&a));
 struct nd_cc_identity reboot=a; reboot.initial_pid=reboot.final_pid=81;
 reboot.native_executor+=0x4000; reboot.runtime+=0x8000; reboot.app_instance_id++; reboot.js_thread+=0x4000;
#if ND_CC_AUTODETECT_IDENTITY
 assert(package_identity(&reboot)); assert(same_identity(&reboot,&reboot));
#else
 assert(!package_identity(&reboot));
#endif
 assert(!same_identity(&a,&reboot));
#define REJECT_FIELD(field,value) do {struct nd_cc_identity b=a;b.field=value;assert(!package_identity(&b));assert(!same_identity(&a,&b));}while(0)
 REJECT_FIELD(complete,0); REJECT_FIELD(stable,0); REJECT_FIELD(credentials_restored,0);
 REJECT_FIELD(backend,2); REJECT_FIELD(firmware,0x13200005); REJECT_FIELD(initial_pid,0); REJECT_FIELD(final_pid,61);
 REJECT_FIELD(native_executor,0); REJECT_FIELD(runtime,0); REJECT_FIELD(app_instance_id,0); REJECT_FIELD(js_thread,0);
#define CHANGED_FIELD(field) do {struct nd_cc_identity b=a;b.field++;assert(!same_identity(&a,&b));}while(0)
 CHANGED_FIELD(native_executor);CHANGED_FIELD(runtime);CHANGED_FIELD(app_instance_id);CHANGED_FIELD(js_thread);
 CHANGED_FIELD(application);CHANGED_FIELD(context);CHANGED_FIELD(data);CHANGED_FIELD(bridge);CHANGED_FIELD(managed_executor);
 CHANGED_FIELD(native_vtable);CHANGED_FIELD(runtime_vtable_candidate);CHANGED_FIELD(native_methods[5]);
 for(int n=0;n<4;n++) {struct nd_cc_identity b=a;b.modules[n].base++;assert(!same_identity(&a,&b));
  b=a;b.modules[n].handle++;assert(!same_identity(&a,&b));b=a;b.modules[n].guard_accepted=0;assert(!same_identity(&a,&b));
  b=a;b.modules[n].identity_unchanged=0;assert(!same_identity(&a,&b));}
 struct nd_cc_identity b=a;strcpy(b.application_name,"other");assert(!same_identity(&a,&b));
 b=a;strcpy(b.bundle_path,"other");assert(!same_identity(&a,&b));
 return 0;
}
""".replace(
            "POLICIES", policies
        )
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            (p / "policy.c").write_text(harness)
            for mode in [0, 1]:
                subprocess.run(
                    [
                        "clang",
                        "-std=c11",
                        "-Wall",
                        "-Wextra",
                        "-Werror",
                        f"-DND_CC_AUTODETECT_IDENTITY={mode}",
                        "-I" + str(ROOT / "tools"),
                        str(p / "policy.c"),
                        "-o",
                        str(p / "policy"),
                    ],
                    check=True,
                )
                subprocess.run([str(p / "policy")], check=True)

    def test_second_load_preserves_audio_and_rejects_conflicts(self):
        script = r"""
const vm=require('node:vm'),assert=require('node:assert/strict');
const source=SOURCE;
function run(kind) {
 let disposed=0,statusCalls=0,installed=0;
 const snap={schema:1,route:'shared-jsx',phase:'installed',cleanupErrors:[],driver:{phase:'installed',entryRoute:'shared-jsx',uiInitialization:'ready',hook:{active:true,removed:false,conflicts:[]},renderer:{runtime:'base_dll',phase:'ready'}}};
 const c=Object.freeze({status(){statusCalls++;return snap},dispose(){disposed++}});
 const context={};
 if(kind!=='empty') Object.defineProperty(context,'__navidromeLocalMusicControl',{value:c,writable:kind==='writable',configurable:true,enumerable:false});
 if(kind==='failed')snap.phase='failed';
 if(kind==='conflict')snap.driver.hook.conflicts.push('jsx');
 if(kind==='removed')snap.driver.hook.active=false;
 if(kind==='disposed')snap.driver.renderer.phase='disposed';
 if(kind==='mismatch')snap.driver.uiInitialization='created';
 if(kind==='cleanup')snap.cleanupErrors.push('failed');
 if(kind==='failed-renderer')snap.driver.renderer.phase='failed';
 let failed=false;try{vm.runInNewContext('(function(){'+source+'; install();})()',{...context,install(){installed++},Object,Array});}catch(e){failed=true;assert.match(e.message,/^NDAUTO:/)}
 assert.equal(disposed,0);
 assert.equal(installed,kind==='empty'?1:0);
 assert.equal(failed,!['empty','good'].includes(kind));
 if(kind==='good')assert.equal(statusCalls,1);
}
// Preserve data descriptors, including nonenumerable own controller.
// vm contexts cannot be spread: use the original object directly.
for(const kind of ['empty','good','writable','failed','conflict','removed','disposed','mismatch','cleanup','failed-renderer'])run(kind);
""".replace(
            "SOURCE", json.dumps(package.automatic_existing_source())
        )
        script = script.replace(
            "{...context,install(){installed++},Object,Array}",
            "Object.assign(context,{install(){installed++},Object,Array})",
        )
        subprocess.run(["node", "-e", script], check=True)

    def test_cli_requires_exactly_one_identity_mode(self):
        for args in [[], ["--auto-detect", "--identity", "unused"]]:
            result = subprocess.run(
                [
                    "python3",
                    str(ROOT / "tools/build_cc_package.py"),
                    "--package-id",
                    "test",
                    *args,
                ],
                capture_output=True,
            )
            self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()

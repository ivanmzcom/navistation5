#!/usr/bin/env python3
"""Exercise the compiled native empty-source gate with bounded fake API replies."""
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
source = (ROOT / "tools/cc_bootstrap_stub.c").read_text()
start = source.index("static bool nd_empty_music_gate(")
end = source.index("\ntypedef void (*nd_free_fn)", start)
gate = source[start:end]
harness = (
    r"""
#include <cstdint>
#include <cstring>
#include <cstdio>
#include "cc_bootstrap_stub.h"
using nd_service_fn = int32_t (*)();
using nd_info_fn = int32_t (*)(int32_t, void*);
"""
    + gate
    + r"""
static int32_t selected;
static int mode, reads, queries;
static int32_t service() {
    ++reads;
    return mode==4 && reads==2 ? selected+1 : selected;
}
static int32_t info(int32_t type, void *pointer) {
    auto *out=static_cast<int32_t *>(pointer);
    std::memset(out, 0, 0x2588);
    ++queries;
    out[1]=-1000; out[2]=type;
    if (mode==1 || mode==2) { out[1]=8; out[7]=mode==1; return 0; }
    if (mode==3) return 0;
    if (mode==5) { static_cast<unsigned char *>(pointer)[0x2588]^=1; }
    if (mode==6) { out[0xc4/4]=1; }
    if (mode==7) { out[2]=type+1; }
    return -1000;
}
static void check(const char *label,int32_t current,int reply,bool expected,int expectedQueries) {
    selected=current; mode=reply; reads=queries=0;
    nd_bootstrap_state s{};
    s.feature0_get_service=reinterpret_cast<uintptr_t>(&service);
    s.feature0_get_info=reinterpret_cast<uintptr_t>(&info);
    bool actual=nd_empty_music_gate(&s);
    if (actual!=expected || queries!=expectedQueries || s.feature0_gate_queries!=static_cast<unsigned>(queries)) {
        std::fprintf(stderr,"%s failed: accepted=%d result=%d queries=%d\n",label,actual,s.feature0_gate_result,queries);
        std::exit(1);
    }
}
int main() {
    check("empty selected alias",10,0,true,4);
    check("empty explicit slot",20,0,true,4);
    check("cold no selection",0,0,true,2);
    check("cold initial sentinel",-3002,0,true,2);
    check("unknown negative selection",-3001,0,false,0);
    check("out of range selection",21,0,false,0);
    check("playing source",10,1,false,1);
    check("paused or removed positive source",10,2,false,1);
    check("impossible success sentinel",10,3,false,1);
    check("selection changed during query",10,4,false,2);
    check("output canary overwritten",10,5,false,1);
    check("nonempty source URI",10,6,false,1);
    check("wrong service in response",10,7,false,1);
    std::puts("13 native empty-source gate cases passed");
}
"""
)
harness = harness.replace("#include <cstdio>", "#include <cstdio>\n#include <cstdlib>")
with tempfile.TemporaryDirectory(prefix="navistation5-native-gate-") as folder:
    cpp = pathlib.Path(folder) / "gate.cpp"
    exe = pathlib.Path(folder) / "gate-test"
    cpp.write_text(harness)
    subprocess.run(
        [
            "c++",
            "-std=c++17",
            "-O2",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-I",
            str(ROOT / "tools"),
            str(cpp),
            "-o",
            str(exe),
        ],
        check=True,
    )
    subprocess.run([str(exe)], check=True)

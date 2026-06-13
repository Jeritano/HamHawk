fn main() {
    // Compile the vendored ft8_lib (MIT) decoder/encoder + our FFI shim into a
    // static lib. LOG_LEVEL is intentionally left undefined so all ft8_lib logging
    // compiles out to no-ops.
    cc::Build::new()
        .include("vendor/ft8_lib")
        .include("csrc")
        .file("csrc/hh_ft8.c")
        .file("vendor/ft8_lib/ft8/constants.c")
        .file("vendor/ft8_lib/ft8/crc.c")
        .file("vendor/ft8_lib/ft8/decode.c")
        .file("vendor/ft8_lib/ft8/encode.c")
        .file("vendor/ft8_lib/ft8/ldpc.c")
        .file("vendor/ft8_lib/ft8/message.c")
        .file("vendor/ft8_lib/ft8/text.c")
        .file("vendor/ft8_lib/fft/kiss_fft.c")
        .file("vendor/ft8_lib/fft/kiss_fftr.c")
        .file("vendor/ft8_lib/common/monitor.c")
        .warnings(false)
        .compile("hh_ft8");

    println!("cargo:rerun-if-changed=csrc/hh_ft8.c");
    println!("cargo:rerun-if-changed=csrc/hh_ft8.h");

    tauri_build::build();
}

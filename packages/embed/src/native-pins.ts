// SHA-256 of the native onnxruntime files the compiled binary loads from its
// sidecar, per platform: the `.node` binding and the runtime library beside it.
//
// The authoritative copy is the table inside patches/onnxruntime-node@1.30.0.patch
// (`sidecarPins` in binding.js), which refuses to load a file that does not
// match. A compiled binary cannot read that file, so `fern doctor` checks the
// installed sidecar against this copy. `test/native-pins.test.ts` fails if the
// two ever differ, and `test/patches-verified.test.ts` checks the patch's table
// against the real files of the pinned package version. Regenerate all of it on
// any onnxruntime-node bump.

export const NATIVE_PINS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  "win32-x64": {
    "onnxruntime_binding.node":
      "ddd428464069b84414d34ec1796c7c2a69c33a976e4b0390692629e394f92fa1",
    "onnxruntime.dll":
      "508c362f5673483dd3a086379c392795b2e42d10d5e6f3f90ebd7ac21c97af67",
  },
  "linux-x64": {
    "onnxruntime_binding.node":
      "ccdc60b981d93a490cf9513d3f583547252b6e285b72988a96a494f2f006c7b8",
    "libonnxruntime.so.1":
      "ffb75a925ba05e47b235bb66e3e3911714a80b328a9c9425539feb204aa32a23",
  },
  "linux-arm64": {
    "onnxruntime_binding.node":
      "afec78dc11d38dc81605b068cefe1fc73ffe77ca240c15468aa40786150beac8",
    "libonnxruntime.so.1":
      "1f549d46250b005580b597f4164984aaf75b3bcb9f3aeb07c7f8a8fe60b23c76",
  },
  "darwin-arm64": {
    "onnxruntime_binding.node":
      "a3f993357759b06ae2411f70af60f5e041d04521ea7f0d12cb7546e411a527dd",
    "libonnxruntime.1.dylib":
      "685d2be5dba1309c89d3a5324b7fd06a5c42f1a61bfea32d14c4cc28d072121d",
  },
};

/** The pins for `<platform>-<arch>`, or undefined for a platform that is not shipped. */
export function nativePinsFor(
  platform: string,
  arch: string,
): Readonly<Record<string, string>> | undefined {
  return NATIVE_PINS[`${platform}-${arch}`];
}

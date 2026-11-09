# Repo-relative toolchain env (works from bash or zsh when sourced).
_WXH_SRC="${BASH_SOURCE[0]:-${(%):-%x}}"
_WXH_ROOT="$(cd "$(dirname "$_WXH_SRC")/.." && pwd)"
if [ -d "$_WXH_ROOT/tools/sdk/jdk/Contents/Home" ]; then export JAVA_HOME="$_WXH_ROOT/tools/sdk/jdk/Contents/Home"; else export JAVA_HOME="$_WXH_ROOT/tools/sdk/jdk"; fi  # macOS JDK bundle / Linux
export ANDROID_HOME="$_WXH_ROOT/tools/sdk/android"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
export PATH="$ANDROID_HOME/platform-tools:$_WXH_ROOT/tools/sdk/gradle-8.9/bin:$JAVA_HOME/bin:$PATH"
unset _WXH_SRC _WXH_ROOT

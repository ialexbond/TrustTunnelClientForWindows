@echo off
set NASM_DIR=C:\Users\naska\AppData\Local\nasm\nasm-2.16.03
set NINJA_DIR=C:\Users\naska\AppData\Local\ninja
set PIP_SCRIPTS=C:\Users\naska\miniconda3\Scripts

rem Setup MSVC environment
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" x64
if errorlevel 1 (
    echo FAILED: vcvarsall.bat
    exit /b 1
)

rem Put our tools in PATH
set PATH=%PIP_SCRIPTS%;%NINJA_DIR%;%NASM_DIR%;%PATH%

echo === Tool versions ===
cmake --version
nasm --version

echo === Available generators ===
cmake --help | findstr /i "Visual"

echo === CMake Configure (Visual Studio 18 2026) ===
cmake -S . -B build -G "Visual Studio 18 2026" -A x64 -DCMAKE_BUILD_TYPE=RelWithDebInfo > build_log.txt 2>&1
if errorlevel 1 (
    echo FAILED: CMake configure. See build_log.txt for details.
    exit /b 1
)
echo CMake configure succeeded.
echo === Building trusttunnel_client ===
cmake --build build --target trusttunnel_client --config Release
if errorlevel 1 (
    echo FAILED: Build
    exit /b 1
)
echo === BUILD SUCCESSFUL ===

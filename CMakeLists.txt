cmake_minimum_required(VERSION 3.24)
if(NOT CMAKE_INSTALL_PREFIX MATCHES "conan2")
    set(CMAKE_PROJECT_TOP_LEVEL_INCLUDES "cmake/conan_bootstrap.cmake")
endif()
project(vpn_libs C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 20)

find_package(quiche)
if (NOT quiche_DIR)
    set(DISABLE_HTTP3 ON)
endif()

if (DISABLE_HTTP3)
    add_compile_definitions(DISABLE_HTTP3)
endif ()

if (MSVC)
    set(CMAKE_MSVC_RUNTIME_LIBRARY MultiThreaded)

    add_compile_definitions(_WIN32_WINNT=0x0601)
    add_compile_definitions(_CRT_SECURE_NO_WARNINGS _CRT_NONSTDC_NO_DEPRECATE)

    add_compile_options(/Oy-) # -fno-omit-frame-pointer
else ()
    add_compile_options(-fno-omit-frame-pointer)
endif ()

add_subdirectory(core)
add_subdirectory(standalone)

enable_testing()

include(GoogleTest)

if(NOT TARGET live_tests)
    add_custom_target(live_tests)
endif(NOT TARGET live_tests)

# `EXPAND_GTEST` is useful if the test has a parametrized gtest case, it often makes the report
# unreadable
function(add_live_test TEST_NAME TEST_DIR EXTRA_INCLUDES IS_GTEST EXPAND_GTEST)
    set(FILE_NO_EXT ${TEST_DIR}/${TEST_NAME})
    if (EXISTS "${FILE_NO_EXT}.cpp")
        set(FILE_PATH ${FILE_NO_EXT}.cpp)
    elseif(EXISTS "${FILE_NO_EXT}.c")
        set(FILE_PATH ${FILE_NO_EXT}.c)
    else()
        message(FATAL_ERROR "Cannot find source file for live test: ${TEST_NAME} (directory=${TEST_DIR})")
    endif()

    add_executable(${TEST_NAME} EXCLUDE_FROM_ALL ${FILE_PATH})
    foreach(INC ${EXTRA_INCLUDES})
        target_include_directories(${TEST_NAME} PRIVATE ${INC})
    endforeach()
    target_compile_definitions(${TEST_NAME} PRIVATE VPNLIBS_LIVE_TEST=1)

    add_dependencies(live_tests ${TEST_NAME})

    if (${IS_GTEST})
        find_package(GTest REQUIRED)
        target_link_libraries(${TEST_NAME} PRIVATE gtest::gtest)
    endif()

    if (NOT VPNLIBS_ENABLE_LIVE_TESTS)
        return()
    endif()

    if (${EXPAND_GTEST} AND NOT ${CMAKE_CROSSCOMPILING})
        gtest_discover_tests(${TEST_NAME} DISCOVERY_TIMEOUT 30 PROPERTIES LABELS "live")
    else()
        add_test(${TEST_NAME} ${TEST_NAME})
        set_tests_properties(${TEST_NAME} PROPERTIES LABELS "live")
    endif()
endfunction()

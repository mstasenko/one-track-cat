# Reuse the authenticated runtime shipped in the pack. Build the GPU plugin
# and its private helper libraries from the same pinned source as before.
function(otc_retarget_runtime directory)
    get_property(targets DIRECTORY "${directory}" PROPERTY BUILDSYSTEM_TARGETS)
    foreach(target IN LISTS targets)
        foreach(property LINK_LIBRARIES INTERFACE_LINK_LIBRARIES)
            get_target_property(links "${target}" "${property}")
            if(links)
                list(TRANSFORM links REPLACE "^(openvino|openvino::runtime)$" "otc_sdk_runtime")
                set_property(TARGET "${target}" PROPERTY "${property}" "${links}")
            endif()
        endforeach()
    endforeach()
    get_property(children DIRECTORY "${directory}" PROPERTY SUBDIRECTORIES)
    foreach(child IN LISTS children)
        otc_retarget_runtime("${child}")
    endforeach()
endfunction()

function(otc_use_sdk_runtime)
    if(NOT TARGET openvino OR NOT TARGET openvino::runtime::dev)
        message(FATAL_ERROR "Pinned OpenVINO runtime targets are missing")
    endif()
    add_library(otc_sdk_runtime SHARED IMPORTED GLOBAL)
    set_property(TARGET otc_sdk_runtime PROPERTY IMPORTED_LOCATION "${OTC_OPENVINO_RUNTIME}")
    # Preserve all header, ABI, compiler and threading requirements. Only the
    # already-shipped core binary replaces its otherwise discarded source build.
    foreach(property INCLUDE_DIRECTORIES SYSTEM_INCLUDE_DIRECTORIES COMPILE_DEFINITIONS
                     COMPILE_FEATURES COMPILE_OPTIONS LINK_LIBRARIES LINK_OPTIONS)
        get_target_property(value openvino "INTERFACE_${property}")
        if(NOT value STREQUAL "value-NOTFOUND")
            set_property(TARGET otc_sdk_runtime PROPERTY "INTERFACE_${property}" "${value}")
        endif()
    endforeach()
    otc_retarget_runtime("${CMAKE_SOURCE_DIR}")
endfunction()

# Project hooks also reach nested project() calls; change only the pinned root.
if(PROJECT_NAME STREQUAL "OpenVINO")
    if(NOT EXISTS "${OTC_OPENVINO_RUNTIME}")
        message(FATAL_ERROR "Authenticated SDK runtime is missing")
    endif()
    cmake_language(DEFER CALL otc_use_sdk_runtime)
endif()

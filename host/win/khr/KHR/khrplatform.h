#ifndef __khrplatform_h_
#define __khrplatform_h_
/*
** Copyright (c) 2008-2018 The Khronos Group Inc.
**
** Permission is hereby granted, free of charge, to any person obtaining a
** copy of this software and/or associated documentation files (the
** "Materials"), to deal in the Materials without restriction, including
** without limitation the rights to use, copy, modify, merge, publish,
** distribute, sublicense, and/or sell copies of the Materials, and to
** permit persons to whom the Materials are furnished to do so, subject to
** the following conditions:
**
** The above copyright notice and this permission notice shall be included
** in all copies or substantial portions of the Materials.
**
** THE MATERIALS ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
** EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
** MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
** IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
** CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
** TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
** MATERIALS OR THE USE OR OTHER DEALINGS IN THE MATERIALS.
*/
/*
** The Windows host's khrplatform.h (host/win/), found before the NDK's that the other emulated hosts use
** (host/CMakeLists.txt). The NDK's copy predates the registry's _WIN64 branch and makes khronos_intptr_t a
** `long`: 32 bits on Windows, where ANGLE's GLintptr/GLsizeiptr are 64. These are the registry's definitions
** (https://registry.khronos.org/EGL/api/KHR/khrplatform.h, MIT-style Khronos licence) for MSVC/clang-cl on x64.
*/
#include <stdint.h>

#if defined(_WIN32) && !defined(KHRONOS_STATIC)
#   define KHRONOS_APICALL __declspec(dllimport)
#else
#   define KHRONOS_APICALL
#endif
#if defined(_WIN32) && !defined(_WIN32_WCE)
#   define KHRONOS_APIENTRY __stdcall
#else
#   define KHRONOS_APIENTRY
#endif
#define KHRONOS_APIATTRIBUTES

typedef int32_t                 khronos_int32_t;
typedef uint32_t                khronos_uint32_t;
typedef int64_t                 khronos_int64_t;
typedef uint64_t                khronos_uint64_t;
#define KHRONOS_SUPPORT_INT64   1
#define KHRONOS_SUPPORT_FLOAT   1
typedef signed   char           khronos_int8_t;
typedef unsigned char           khronos_uint8_t;
typedef signed   short int      khronos_int16_t;
typedef unsigned short int      khronos_uint16_t;
#ifdef _WIN64
typedef signed   long long int  khronos_intptr_t;
typedef unsigned long long int  khronos_uintptr_t;
typedef signed   long long int  khronos_ssize_t;
typedef unsigned long long int  khronos_usize_t;
#else
typedef signed   long  int      khronos_intptr_t;
typedef unsigned long  int      khronos_uintptr_t;
typedef signed   long  int      khronos_ssize_t;
typedef unsigned long  int      khronos_usize_t;
#endif
typedef          float          khronos_float_t;
typedef khronos_uint64_t        khronos_utime_nanoseconds_t;
typedef khronos_int64_t         khronos_stime_nanoseconds_t;
#ifndef KHRONOS_MAX_ENUM
#define KHRONOS_MAX_ENUM 0x7FFFFFFF
#endif
typedef enum { KHRONOS_FALSE = 0, KHRONOS_TRUE = 1, KHRONOS_BOOLEAN_ENUM_FORCE_SIZE = KHRONOS_MAX_ENUM } khronos_boolean_enum_t;

#endif /* __khrplatform_h_ */

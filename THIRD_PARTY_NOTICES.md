# 第三方组件与源码来源

本扩展原创源码按 GPL-3.0-or-later 提供；第三方版权和许可保持不变。下面列出实际锁定的运行依赖，不把 JavaScript 包的 MIT 许可误用于 FFmpeg 核心。

| 组件 | 锁定版本 | 上游声明许可 | 用途 |
| --- | --- | --- | --- |
| `@ffmpeg/ffmpeg` | 0.12.15 | MIT | 浏览器 Worker / FFmpeg API 包装层。 |
| `@ffmpeg/core` | 0.12.10 | GPL-2.0-or-later | 单线程 FFmpeg JavaScript 与 WASM 核心。 |
| `@ffmpeg/types` | 0.12.4 | MIT | 包装层的类型依赖；开发时安装。 |
| esbuild | 0.28.2 | MIT | 构建工具，不随运行包作为工具执行。 |
| Playwright / playwright-core | 1.64.1 | Apache-2.0 | 浏览器测试工具，不随扩展运行包分发浏览器。 |

版本与 npm tarball 的 `resolved`、`integrity` 以根目录 `package-lock.json` 为准。`npm ci` 校验锁定包。运行包中的第三方代码由这些包复制或打包得到，本项目未修改上游 WASM 核心。

## FFmpeg 0.12 系列的对应来源

已核对的共同发布标签是 [`v12.15`](https://github.com/ffmpegwasm/ffmpeg.wasm/releases/tag/v12.15)，提交 **`71aa99d37c02a7b4c435275ca9ef50e612f6efa1`**；该发布同时包含 main 0.12.15 与 core 0.12.10。

- [包装层 package.json（0.12.15 / MIT）](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/v12.15/packages/ffmpeg/package.json)、[包装层源代码](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v12.15/packages/ffmpeg/src)、[MIT 原文](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/v12.15/LICENSE)。版权声明：Copyright (c) 2019 Jerome Wu。
- [核心 package.json（0.12.10 / GPL-2.0-or-later）](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/v12.15/packages/core/package.json)、[发布源代码归档](https://github.com/ffmpegwasm/ffmpeg.wasm/archive/refs/tags/v12.15.tar.gz)。
- [核心 Dockerfile](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/v12.15/Dockerfile)、[构建脚本](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v12.15/build)、[绑定与工具代码](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v12.15/src)。Dockerfile 使用 FFmpeg n5.1.4、Emscripten 3.1.40，并启用 GPL 组件。
- [FFmpeg n5.1.4 源码](https://github.com/FFmpeg/FFmpeg/tree/n5.1.4)、[GPL v2 文本](https://github.com/FFmpeg/FFmpeg/blob/n5.1.4/COPYING.GPLv2)、[FFmpeg 许可说明](https://github.com/FFmpeg/FFmpeg/blob/n5.1.4/LICENSE.md)。

`bili-local-downloader-1.0.1-source.zip` 收录本扩展源码、构建流程与锁文件，不将第三方 WASM 反编译结果或整套第三方源码冒充为本项目源码。第三方完整源码、补丁及构建入口由以上上游链接和下表定位。上游 Dockerfile 的部分依赖使用分支引用，重新编译核心不承诺与 npm 二进制逐字节一致；重新构建本扩展则复用 integrity 固定的 npm 核心。

## 核心关联的库与许可原文

下列来源依据上述 Dockerfile；各项目保留其自身版权。许可文本随扩展保存于 `licenses/`（项目源码中为 `static/licenses/`）；`SOURCES.json` 记录下载来源、日期与 SHA-256。zlib 文件保存了 `zlib.h` 中的完整许可段。FreeType 采用其 FTL 许可路径。

| 库 / 构建来源 | 上游源代码 | 本地许可文本 |
| --- | --- | --- |
| FFmpeg n5.1.4 | [FFmpeg](https://github.com/FFmpeg/FFmpeg/tree/n5.1.4) | `GPL-2.0.txt`、`GPL-3.0.txt`、`LGPL-2.1.txt` |
| x264，`4-cores` | [ffmpegwasm/x264](https://github.com/ffmpegwasm/x264/tree/4-cores) | `x264-COPYING.txt` |
| x265，3.4 | [ffmpegwasm/x265](https://github.com/ffmpegwasm/x265/tree/3.4) | `x265-COPYING.txt` |
| libvpx，v1.13.1 | [ffmpegwasm/libvpx](https://github.com/ffmpegwasm/libvpx/tree/v1.13.1) | `libvpx-LICENSE.txt` |
| LAME，`master` | [ffmpegwasm/lame](https://github.com/ffmpegwasm/lame/tree/master) | `lame-COPYING.txt` |
| Ogg，v1.3.4 | [ffmpegwasm/Ogg](https://github.com/ffmpegwasm/Ogg/tree/v1.3.4) | `ogg-COPYING.txt` |
| Theora，v1.1.1 | [ffmpegwasm/theora](https://github.com/ffmpegwasm/theora/tree/v1.1.1) | `theora-COPYING.txt` |
| Opus，v1.3.1 | [ffmpegwasm/opus](https://github.com/ffmpegwasm/opus/tree/v1.3.1) | `opus-COPYING.txt` |
| Vorbis，v1.3.3 | [ffmpegwasm/vorbis](https://github.com/ffmpegwasm/vorbis/tree/v1.3.3) | `vorbis-COPYING.txt` |
| zlib，v1.2.11 | [ffmpegwasm/zlib](https://github.com/ffmpegwasm/zlib/tree/v1.2.11) | `zlib-LICENSE.txt` |
| libwebp，v1.3.2 | [ffmpegwasm/libwebp](https://github.com/ffmpegwasm/libwebp/tree/v1.3.2) | `libwebp-COPYING.txt` |
| FreeType，VER-2-10-4 | [ffmpegwasm/freetype2](https://github.com/ffmpegwasm/freetype2/tree/VER-2-10-4) | `freetype-LICENSE.txt` |
| FriBidi，v1.0.9 | [fribidi/fribidi](https://github.com/fribidi/fribidi/tree/v1.0.9) | `fribidi-COPYING.txt` |
| HarfBuzz，5.2.0 | [harfbuzz/harfbuzz](https://github.com/harfbuzz/harfbuzz/tree/5.2.0) | `harfbuzz-COPYING.txt` |
| libass，0.15.0 | [libass/libass](https://github.com/libass/libass/tree/0.15.0) | `libass-COPYING.txt` |
| zimg，release-3.0.5 | [sekrit-twc/zimg](https://github.com/sekrit-twc/zimg/tree/release-3.0.5) | `zimg-COPYING.txt` |
| Emscripten，3.1.40 | [emscripten-core/emscripten](https://github.com/emscripten-core/emscripten/tree/3.1.40) | `emscripten-LICENSE.txt` |
| SDL2，release-2.24.2（工具链端口） | [libsdl-org/SDL](https://github.com/libsdl-org/SDL/tree/release-2.24.2)；[端口配置](https://github.com/emscripten-core/emscripten/blob/3.1.40/tools/ports/sdl2.py) | `SDL2-LICENSE.txt` |

本项目未随发布包分发 Node.js、Python、Playwright 下载的 Chromium 或其他开发者工具。若再次分发运行包或修改后的核心，应保留本文件、许可文本和相应源码获取信息，并按各许可证履行适用的源码提供要求。

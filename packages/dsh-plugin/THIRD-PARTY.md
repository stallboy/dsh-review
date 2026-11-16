# 插件第三方许可

> **任务来源**: 用户授权将 DSH 插件迁入独立 workspace 并独立分发。
> **任务内容**: 随插件保留内置 YAML 解析器的许可声明。
> **参考文档**:
> - `src/host/vendor/js-yaml.ts` — 内置 js-yaml 实现。
> - `package.json` — 插件分发清单。
> **生成日期**: 2026-11-16

## js-yaml 4.3.2

内置实现位于 `src/host/vendor/js-yaml.ts`，编译为 `dist/host/vendor/js-yaml.js`，用于读取和写入评审 YAML。

```text
(The MIT License)

Copyright (C) 2011-2015 by Vitaly Puzrin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

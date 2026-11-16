# 第三方许可声明

> **任务来源**: 用户授权将插件和中央服务整理为独立包。
> **任务内容**: 记录迁移后内置组件的位置并保留原许可。
> **参考文档**:
> - `packages/dsh-plugin/THIRD-PARTY.md` — 随插件分发的 js-yaml 许可。
> - `apps/server/package.json` — 中央服务运行依赖。
> **生成日期**: 2026-11-16

## js-yaml 4.3.2

插件内置实现位于 `packages/dsh-plugin/src/host/vendor/js-yaml.ts`，编译为插件包内的 `dist/host/vendor/js-yaml.js`，用于读写评审 YAML。中央服务的第三方运行依赖声明在自身 package.json 中，其许可文件随依赖一起进入安装包。

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

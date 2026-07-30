# 贡献指南

感谢你考虑改进飞书 Codex Bridge。这个项目位于聊天平台、Codex 和本机文件系统之间，安全边界的改动需要比普通功能修改更严格的验证。

## 开发环境

- Node.js 20 或更高版本
- `package.json` 的 `bridgeToolchain` 中锁定的 Codex CLI 与飞书 CLI 版本
- Windows 是当前主要支持平台

克隆仓库后运行：

```powershell
npm test
npm run check
npm run check:public
```

## 提交修改

1. 先创建 Issue 描述行为、风险和预期结果；小型文档修正可直接提交 Pull Request。
2. 保持修改范围集中，不要在同一提交中混入无关重构。
3. 行为变化必须补充与风险相称的测试。
4. 涉及审批、路径验证、进程隔离、会话 lease、事件鉴权或部署回滚时，说明威胁模型和失败时的默认行为。
5. 不要提交真实的 `bridge.config.json`、飞书 ID、访问令牌、会话记录、本机路径或运行日志。

## 兼容性变更

升级 Codex CLI 或飞书 CLI 不能只修改 `package.json` 的工具链版本。Pull Request 必须包含协议差异审计、对应测试，并说明真实环境验证结果。安全检查无法完成时应保持 fail-closed。

## Pull Request 检查项

- 全量测试通过。
- `npm run check` 通过。
- `npm run check:public` 通过。
- 文档和示例配置与行为一致。
- 没有新增凭据、个人标识或机器相关路径。

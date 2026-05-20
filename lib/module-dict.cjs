// lib/module-dict.cjs — 内置模块英文目录名 → 中文名映射字典
'use strict';

/**
 * 内置模块英文目录名 → 中文名映射字典（可扩展）。
 * 未命中的目录名原样保留。
 *
 * 注意：Settings 和 Global 均映射到 "全局设置"，反向构建时以最后一个 key 为准（Global）。
 * 实际使用中用户界面只展示中文，不影响正确性。
 *
 * @type {Record<string, string>}
 */
const MODULE_DICT = {
  Router:      '路由管理',
  Service:     '服务管理 L7',
  Service4:    '服务管理 L4',
  Faas:        'FaaS 管理',
  Plugin:      '插件管理',
  Policy:      '策略管理',
  Tls:         'TLS 管理',
  Settings:    '全局设置',
  Global:      '全局设置',
  Context:     '上下文管理',
  Auth:        '认证管理',
  Log:         '日志管理',
  Monitor:     '监控管理',
  Cluster:     '集群管理',
  Dashboard:   '监控面板',
  Group:       '分组管理',
  User:        '用户管理',
  Role:        '角色管理',
  System:      '系统管理',
};

module.exports = { MODULE_DICT };

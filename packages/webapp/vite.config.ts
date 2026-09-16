import 'dotenv/config';
import { resolve } from 'node:path';

import { defineConfig, type Plugin, type ResolvedConfig } from 'vite';

const config = async ({ command }: any) => {
  return defineConfig({
    root: 'src',
    base: '/',
    publicDir: resolve(process.cwd(), 'public'),
    resolve: {
      alias: {
        src: '',
      },
      dedupe: ['@mantou/gem'],
    },
    build: {
      outDir: resolve(process.cwd(), 'dist'),
      emptyOutDir: false,
      sourcemap: true,
    },
    esbuild: {
      target: 'es2022',
    },
    plugins: [VitePluginPrefetchAll()],
    define: {
      'process.env.RELEASE': JSON.stringify(Date.now()),
      'process.env.COMMAND': JSON.stringify(command),
      'process.env.API_BASE': JSON.stringify(process.env.API_BASE),
      // 私有化部署：外部资源代理域名
      // 未设置时保持官方默认值；设置为 "off" 禁用代理（使用相对路径）
      'process.env.CORS_ORIGIN': JSON.stringify(
        process.env.CORS_ORIGIN ?? 'https://files.xianqiao.wang',
      ),
      // 私有化部署：AI 搜索服务地址（为空时禁用）
      'process.env.AI_SEARCH_BASE': JSON.stringify(process.env.AI_SEARCH_BASE ?? ''),
      // 私有化部署：AI 问答补全服务地址（为空时禁用）
      'process.env.AI_COMPLETIONS_BASE': JSON.stringify(process.env.AI_COMPLETIONS_BASE ?? ''),
    },
    server: {
      allowedHosts: true,
      host: '0.0.0.0',
      port: 3003,
    },
  });
};

export default config;

function VitePluginPrefetchAll(): Plugin {
  let viteConfig: ResolvedConfig;
  return {
    name: 'vite:vite-plugin-prefetch',
    configResolved(config) {
      viteConfig = config;
    },
    transformIndexHtml(html, ctx) {
      if (!ctx.bundle) return html;

      return Object.values(ctx.bundle)
        .filter((bundle) => !bundle.fileName.endsWith('.map'))
        .map((bundle) => `${viteConfig.base}${bundle.fileName}`)
        .map((href) => ({
          tag: 'link',
          attrs: { rel: 'prefetch', href },
          injectTo: 'head',
        }));
    },
  };
}

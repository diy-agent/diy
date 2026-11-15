import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
    plugins: [
        // React Compiler（React 19 的自动 memo 是**编译期**能力，默认不开）
        // v6 的原生入口走 oxc-transform-react；logDiagnostics 把"跳过优化"打出来
        react({ compiler: { target: '19', logDiagnostics: true } }),
        tailwindcss(),
    ],
    server: {
        proxy: {
            '/api': 'http://localhost:5191',
        },
    },
});

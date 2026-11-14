// TypingDots —— "已收到，正在想"的三个点。
//
// 为什么需要：外部存储模式下，assistant 消息是懒创建的（有内容才出现）。
// 用户发完消息到模型吐出第一个 token 之间，界面上只有投递 chip，
// 看起来像"没反应"。这个占位填住那段空窗（两个 surface 共用）。

export function TypingDots({ size = 6 }: { size?: number }) {
    return (
        <span style={{ display: 'inline-flex', gap: size * 0.7, padding: '3px 0' }} aria-label="正在输入">
            {[0, 1, 2].map((index) => (
                <span
                    key={index}
                    style={{
                        width: size,
                        height: size,
                        borderRadius: 999,
                        background: 'currentColor',
                        opacity: 0.3,
                        animation: `diy-typing 1.2s ${index * 0.15}s infinite ease-in-out`,
                    }}
                />
            ))}
            <style>{`@keyframes diy-typing { 0%,60%,100% { opacity:.25; transform: translateY(0) } 30% { opacity:1; transform: translateY(-2px) } }`}</style>
        </span>
    );
}

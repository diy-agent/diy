import { useNotificationStore, type ToastType } from "./store/notificationStore";
import { cn } from "@/lib/utils";

const typeStyle: Record<ToastType, string> = {
  info: "bg-diy-state-active text-black",
  success: "bg-diy-state-done text-black",
  error: "bg-destructive text-destructive-foreground",
};

function ToastItem({ id, type, message }: { id: string; type: ToastType; message: string }) {
  const removeToast = useNotificationStore((s) => s.removeToast);

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg px-4 py-2 text-sm shadow-lg animate-in slide-in-from-right",
        typeStyle[type],
      )}
    >
      <span className="flex-1">{message}</span>
      <button onClick={() => removeToast(id)} className="opacity-60 hover:opacity-100 text-xs">
        ✕
      </button>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useNotificationStore((s) => s.toasts);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 min-w-64 max-w-sm pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastItem id={t.id} type={t.type} message={t.message} />
        </div>
      ))}
    </div>
  );
}

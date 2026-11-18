// nav/orphans.tsx —— 内建来源③：没挂在任何项目下的容器。
//
// 老数据丢过 projectId，以后还会有别的类型（stock / doc…）。按 projectId 分组的写法
// 会让它们直接消失 —— 数据还在却永远进不去。

import { RoomRow } from '../components/RoomRow';
import { visibleInTree } from '../model';
import type { NavContext, NavSource } from '../nav';
import { useStore } from '../store';

function OrphansBlock({ context }: { context: NavContext }) {
    const state = useStore();
    const { open, host } = context;
    const projectIds = new Set(state.rooms.filter((room) => room.type === 'project').map((project) => project.id));
    const orphans = state.rooms.filter(
        (room) =>
            room.type !== 'project' && visibleInTree(room) && !projectIds.has(String(room.data['projectId'] ?? '')),
    );
    if (orphans.length === 0) return null;

    return (
        <div className={open ? 'mb-2' : 'mb-1'}>
            {open && <div className="px-2 pb-1 text-[11px] text-muted-foreground">未归属</div>}
            {orphans.map((room) => (
                <RoomRow key={room.id} room={room} compact={!open} onRequestDelete={host.onRequestDelete} />
            ))}
        </div>
    );
}

export const orphansSource: NavSource = {
    id: 'core:orphans',
    order: 30,
    render: (context) => <OrphansBlock context={context} />,
};

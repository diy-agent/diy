// nav/orphans.tsx —— 内建来源③：没挂在任何项目下的容器。
//
// 老数据丢过 projectId，以后还会有别的类型（stock / doc…）。按 projectId 分组的写法
// 会让它们直接消失 —— 数据还在却永远进不去。

import { RoomRow } from '../components/RoomRow';
import { visibleInProjectTree } from '../model';
import type { NavContext, NavSource } from '../nav';
import { useRooms } from '../store';

function OrphansBlock({ context }: { context: NavContext }) {
    // 只订阅列表本身（见 ProjectsBlock 的同一条理由）
    const rooms = useRooms();
    const { open, host } = context;
    const projectIds = new Set(rooms.filter((room) => room.type === 'project').map((project) => project.id));
    const orphans = rooms.filter(
        (room) =>
            room.type !== 'project' &&
            visibleInProjectTree(room) &&
            !projectIds.has(String(room.data['projectId'] ?? '')),
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

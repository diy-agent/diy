import asyncio

from helpers import FakeApp


def test_concurrent_async_cells_interference():
    """测试并发异步 cell 是否互相干扰。
    
    两个 cell 同时运行，分别 yield awaitable。
    如果使用非异步安全的全局 context，它们会互相覆盖 active_cell，导致依赖错乱。
    """
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    
    app = FakeApp()
    sig1 = app.signal(0)
    sig2 = app.signal(0)
    
    results1 = []
    results2 = []

    # Cell 1: 慢一点 (0.1s)
    col1 = app.column()
    @col1.cell()
    async def cell1(node):
        results1.append(f"start1-{sig1.value}")
        await asyncio.sleep(0.1)
        results1.append(f"mid1-{sig1.value}")
        yield app.markdown("cell1")
        results1.append(f"end1-{sig1.value}")

    # Cell 2: 快一点 (0.01s)
    col2 = app.column()
    @col2.cell()
    async def cell2(node):
        results2.append(f"start2-{sig2.value}")
        await asyncio.sleep(0.01)
        results2.append(f"mid2-{sig2.value}")
        yield app.markdown("cell2")
        results2.append(f"end2-{sig2.value}")

    async def run():
        # 等待 Initial 执行完成
        await asyncio.sleep(0.2)
        
        # 触发 sig1, sig2 变化，使它们 rerun
        sig1.value = 1
        sig2.value = 1
        
        # 等待 rerun 执行完成
        await asyncio.sleep(0.5)

    try:
        loop.run_until_complete(run())
    finally:
        loop.close()
    
    # 检查依赖：sig1 应该只有 col1，sig2 应该只有 col2
    assert col1 in sig1._system_observers
    assert col2 in sig2._system_observers
    assert len(sig1._system_observers) == 1
    assert len(sig2._system_observers) == 1
    
    # 检查执行轨迹，确保各自都读到了正确的值且完整执行
    assert results1 == ["start1-0", "mid1-0", "end1-0", "start1-1", "mid1-1", "end1-1"]
    assert results2 == ["start2-0", "mid2-0", "end2-0", "start2-1", "mid2-1", "end2-1"]

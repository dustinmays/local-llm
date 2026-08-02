import socket

import mlx.core as mx


world = mx.distributed.init()
rank = world.rank()
size = world.size()
summed = mx.distributed.all_sum(mx.array(rank + 1))
mx.eval(summed)
total = summed.item()

print(f"rank={rank} size={size} host={socket.gethostname()} all_sum={total}", flush=True)
if size != 2 or total != 3:
    raise RuntimeError(f"expected two ranks and all_sum=3, got size={size}, total={total}")

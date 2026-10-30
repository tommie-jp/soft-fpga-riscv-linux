# soft-fpga-riscv-linux

[日本語](README.ja.md)

Boot Linux on the RTL of a RISC-V core, turned into C++ by Verilator. A boot saved on a PC is
restored by a Wasm build of the same model, so the browser starts at the BusyBox shell. A logic
analyzer shows the signals inside the CPU, clock by clock, from a key press through the interrupt
into the kernel.

The only core so far is [mmRISC-2](https://github.com/munetomo-maruyama/mmRISC-2) (RV64GC, Sv39).
This is a personal project that uses mmRISC-2; it is not endorsed by the author of mmRISC-2.

Pages: <https://tommie-jp.github.io/soft-fpga-riscv-linux/>

## Requirements

- Verilator 5.042 (other 5.x releases probably build, but a saved state only loads into a model
  built by the same release)
- python3, fakeroot, cpio, e2fsprogs (`mke2fs`), fdisk (`sfdisk`), dpkg (`dpkg-deb`), curl
- For the browser build: [emsdk](https://emscripten.org/docs/getting_started/downloads.html) (`em++`)
  and Node.js
- No RISC-V cross compiler: the kernel and OpenSBI come from the mmRISC-2 repository, and BusyBox is
  the `busybox-static` package of Debian 13 for riscv64

```bash
git clone --recurse-submodules https://github.com/tommie-jp/soft-fpga-riscv-linux.git
cd soft-fpga-riscv-linux
make rootfs          # the BusyBox tree, in build/rootfs/rv64-busybox/
```

## Run

```bash
make linux-sd-save < /dev/null   # boot and save at the first prompt into state/ (about 14 min on a PC, once)
make restore                     # start from the saved state, interactive (Ctrl-] quits)
make wasm-restore LINES=ls       # the same with the Wasm model under Node
make web-serve                   # serve the browser build at http://localhost:8059/
```

There are also `make linux` (no SD card, up to where the kernel waits for root) and `make linux-sd`
(to the shell without saving). Pick the core with `make CORE=<core> ...` (default `mmrisc2`).

Saved states are `state/<core>-<md5 of the Verilog>.state` (336 MB raw, 8.3 MB gzipped for the
pages). Changing the Verilog changes the name: save again.

The terminal of `make restore` does not pass cursor position reports (`ESC[row;colR`) to the model.
Passing them makes ash drop typed keys for a while, and the first line is lost.

## Layout

```text
Makefile                 passes make CORE=<core> <target> to sim/
sim/                     shared: runs the model (clock, UART, save and restore); wasm/ is the Wasm build
periph/litex/            shared: models of the LiteX SoC peripherals (UART with receive)
web/                     shared: index (index.html), core page (core/), worker, logic analyzer
rootfs/rv64-busybox/     BusyBox tree shared by RV64 cores
cores/<core>/            per core: top .sv, core.mk, load.cpp, upstream (submodule)
scripts/deploy-pages.sh  puts dist/ on gh-pages
```

Build outputs are `build/<core>/`, `state/` and `dist/`, kept out of git.

### Shared and per-core parts

- The model connects through the ports of its top: `clk`, `rst_n`, `uart_tx_*`, `uart_rx_*`,
  `max_cycles`, `stop_code`, `cycle_count`, `obs_*`
- Every core drives `obs_*` (retire, PC, privilege, trap, TLB miss, main memory); a signal a core
  cannot provide is 0. The logic analyzer's signal definitions (`web/la-defs.js`) are then shared.
  The top also drives the writeback (`obs_rd*`), interrupt lines and `mip`/`mie`, `satp`, L1
  requests, performance events (`obs_events`) and SoC state (`obs_dev`)
- Register window: put a number on `reg_sel` (0-31 x, 32-63 f, 64 and up CSRs) and eval; the value
  is on `reg_val`. The clock does not move, so the model state does not change. The Wasm build
  fills the register panel this way
- The Linux environment (kernel, OpenSBI, device tree, saved state) is per core. The rootfs is
  shared by ISA width

## License

Files of this repository are Apache-2.0 ([LICENSE](LICENSE)). Exceptions and origins are in
[NOTICE](NOTICE).

- `cores/mmrisc2/upstream/`: mmRISC-2 (Apache-2.0). The Linux kernel in it is GPL-2.0 and OpenSBI is
  BSD-2-Clause (see the NOTICE of mmRISC-2)
- `tb_mmrisc2.sv` and `LITEX_PERIPH_RX.sv` are derived from files of mmRISC-2; the changes are listed
  at the top of each
- `web/la/` and part of `sim/wasm/` are copied from [soft-FPGA](https://github.com/tommie-jp/soft-fpga)
  (MIT, [LICENSES/MIT-soft-fpga.txt](LICENSES/MIT-soft-fpga.txt))
- The saved state of the pages (`state.gz`) contains Linux, OpenSBI and BusyBox (Debian's
  `busybox-static`, GPL-2.0); their origins are listed at the bottom of the page

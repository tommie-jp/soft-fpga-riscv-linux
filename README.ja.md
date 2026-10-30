# soft-fpga-riscv-linux

[English](README.md)

RISC-V のコアの RTL を Verilator で C++ にし、Linux を起こします。PC で起動を済ませて保存した状態を
Wasm の模型で読み戻すと、ブラウザで BusyBox のシェルから始められます。Logic Analyzer で、打鍵から
割り込み・カーネルまでの CPU の中の信号を 1 クロックずつ見られます。

いまのコアは [mmRISC-2](https://github.com/munetomo-maruyama/mmRISC-2) (RV64GC、Sv39) だけです。
mmRISC-2 を使った個人の試みで、mmRISC-2 の作者の公認ではありません。

ページ: <https://tommie-jp.github.io/soft-fpga-riscv-linux/>

## 用意

- Verilator 5.042 (ほかの 5.x でも作れる見込みですが、保存ファイルは同じ版の模型でしか読めません)
- python3、fakeroot、cpio、e2fsprogs (`mke2fs`)、fdisk (`sfdisk`)、dpkg (`dpkg-deb`)、curl
- ブラウザ版を作るなら [emsdk](https://emscripten.org/docs/getting_started/downloads.html) (`em++`) と Node.js
- RISC-V のクロスコンパイラは要りません。カーネルと OpenSBI は mmRISC-2 のリポジトリに入っている物を使い、
  BusyBox は Debian 13 の riscv64 の `busybox-static` を使います

```bash
git clone --recurse-submodules https://github.com/tommie-jp/soft-fpga-riscv-linux.git
cd soft-fpga-riscv-linux
make rootfs          # build/rootfs/rv64-busybox/ に BusyBox の木を作る
```

## 動かす

```bash
make linux-sd-save < /dev/null   # 起動して最初のプロンプトで state/ に保存 (PC で約 14 分、1 度だけ)
make restore                     # 保存した所から端末で対話 (Ctrl-] で終わる)
make wasm-restore LINES=ls       # 同じことを Wasm の模型を Node で回して
make web-serve                   # ブラウザ版を http://localhost:8059/ で配る
```

ほかに `make linux` (SD カード無しで、カーネルが root を待つ所まで) と `make linux-sd` (保存せずにシェルまで)
があります。コアは `make CORE=<コア> ...` で選びます (既定は `mmrisc2`)。

保存ファイルは `state/<コア>-<Verilog の md5>.state` (生で 336 MB、配る形の gzip で 8.3 MB) です。
Verilog を変えると名前が変わるので、保存し直します。

端末 (`make restore`) はカーソル位置の答え (`ESC[行;桁R`) を模型に渡しません。渡すと、ash が打った字を
しばらく捨て、最初の行が消えます。

## 構成

```text
Makefile                 make CORE=<コア> <的> を sim/ に渡す
sim/                     共通: 模型を回す道具 (時計・UART・保存と読み戻し)。wasm/ は Wasm 版
periph/litex/            共通: LiteX の SoC の周辺回路の模型 (UART の受信付き)
web/                     共通: 目次 (index.html) とコアのページ (core/)、Worker、Logic Analyzer
rootfs/rv64-busybox/     RV64 のコアで共通の BusyBox の木
cores/<コア>/            コア別: トップの .sv・core.mk・load.cpp・上流 (submodule)
scripts/deploy-pages.sh  dist/ を gh-pages に置く
```

作る物は `build/<コア>/`、`state/`、`dist/` で、git には入れません。

### 共通とコア別の境目

- 模型とはトップのポートでつながります: `clk`・`rst_n`・`uart_tx_*`・`uart_rx_*`・`max_cycles`・
  `stop_code`・`cycle_count`・`obs_*`
- `obs_*` (退役・PC・特権・トラップ・TLB ミス・主記憶) はどのコアでも出す約束です。出せない信号は 0 にします。
  そうすれば Logic Analyzer の信号の定義 (`web/la-defs.js`) も共通にできます。
  ほかに書き戻し (`obs_rd*`)・割り込みの線と `mip`/`mie`・`satp`・L1 への要求・性能の事象 (`obs_events`)・
  SoC の状態 (`obs_dev`) も出します
- レジスタの窓: `reg_sel` に番号 (0-31 x、32-63 f、64- CSR) を置いて eval すると `reg_val` に値が出ます。
  クロックは動かさないので、模型の状態は変わりません。Wasm はこれでレジスタの欄を作ります
- Linux の環境 (カーネル・OpenSBI・device tree・保存ファイル) はコア別です。rootfs は ISA の幅で共通です

## ライセンス

このリポジトリの物は Apache-2.0 ([LICENSE](LICENSE)) です。例外と出どころは [NOTICE](NOTICE) にあります。

- `cores/mmrisc2/upstream/`: mmRISC-2 (Apache-2.0)。中の Linux は GPL-2.0、OpenSBI は BSD-2-Clause
  (mmRISC-2 の NOTICE)
- `tb_mmrisc2.sv` と `LITEX_PERIPH_RX.sv` は mmRISC-2 のファイルから作り、変えた所を頭に書いてあります
- `web/la/` と `sim/wasm/` の一部は [soft-FPGA](https://github.com/tommie-jp/soft-fpga) から写した物 (MIT、
  [LICENSES/MIT-soft-fpga.txt](LICENSES/MIT-soft-fpga.txt))
- ページの保存した状態 (`state.gz`) には Linux・OpenSBI・BusyBox (Debian の `busybox-static`、GPL-2.0) が
  入ります。出どころはページの下に載せてあります

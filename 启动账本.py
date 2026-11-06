# -*- coding: utf-8 -*-
"""
本地账本 · 启动器

  python 启动账本.py              仅本机访问   http://127.0.0.1:8899/
  python 启动账本.py --lan        允许同一 WiFi 下的手机/平板访问
  python 启动账本.py --port 9000  换端口
  python 启动账本.py --no-browser 不自动开浏览器

启动后：
  · 自动起一个只读本地 HTTP 服务（账单文件在浏览器里解析，不会传给这个服务）
  · 等端口真正就绪后才打开浏览器，避免"第一次打开显示无法访问"
  · Ctrl+C 或关掉窗口即停止服务
"""
import argparse
import http.server
import os
import socket
import socketserver
import sys
import threading
import time
import urllib.request
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    """只提供本目录下的静态文件，并关掉缓存，改完代码刷新就生效。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        pass  # 不刷屏

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def port_open(host, port):
    try:
        with socket.create_connection((host, port), timeout=0.4):
            return True
    except OSError:
        return False


def is_own_service(port):
    """端口上跑的是不是本地账本。

    端口被占用有两种情况：上次的服务还在跑（可以直接用），
    或者被别的程序占了（这时把浏览器打开过去只会看到一个陌生的网站）。
    """
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d/index.html' % port, timeout=1.2) as r:
            body = r.read(8192).decode('utf-8', 'ignore')
        return '本地账本' in body or 'LedgerCalc' in body
    except Exception:
        return False


def local_ip():
    """取本机在局域网里的 IP，给手机用。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('--port', type=int, default=8899)
    ap.add_argument('--lan', action='store_true', help='允许局域网（手机）访问')
    ap.add_argument('--no-browser', action='store_true', help='不自动打开浏览器')
    args = ap.parse_args()

    host = '0.0.0.0' if args.lan else '127.0.0.1'
    shown = '127.0.0.1' if not args.lan else local_ip()
    url = 'http://%s:%d/index.html' % (shown, args.port)

    # 端口已被占用：先分清是"上次的服务还在跑"还是"别的程序占了"
    if port_open('127.0.0.1', args.port):
        if is_own_service(args.port):
            print('检测到端口 %d 上已经在跑本地账本，直接打开现有服务。' % args.port)
            if not args.no_browser:
                webbrowser.open(url)
            return 0
        print('端口 %d 被别的程序占用了，那上面不是本地账本。' % args.port)
        print('可以用 --port 换一个端口，例如：python 启动账本.py --port %d' % (args.port + 1))
        print('或者直接双击 index.html 用浏览器打开。')
        return 1

    try:
        httpd = Server((host, args.port), Handler)
    except OSError as e:
        print('端口 %d 无法启动：%s' % (args.port, e))
        print('可以用 --port 换一个端口，或直接双击 index.html 用浏览器打开。')
        return 1

    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()

    # 等端口真的起来了再开浏览器
    for _ in range(50):
        if port_open('127.0.0.1', args.port):
            break
        time.sleep(0.1)

    print('')
    print('  本地账本已启动')
    print('  本机访问： http://127.0.0.1:%d/index.html' % args.port)
    if args.lan:
        print('  手机访问： http://%s:%d/index.html   (需连同一个 WiFi)' % (local_ip(), args.port))
    print('')
    print('  账单文件全部在你的浏览器里解析，这个服务只负责发静态文件。')
    print('  按 Ctrl+C 停止服务。')
    print('')

    if not args.no_browser:
        webbrowser.open(url)

    try:
        while t.is_alive():
            t.join(0.5)
    except KeyboardInterrupt:
        print('\n已停止服务。')
        httpd.shutdown()
    return 0


if __name__ == '__main__':
    sys.exit(main())

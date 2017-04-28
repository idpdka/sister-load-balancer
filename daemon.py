from http.server import HTTPServer, BaseHTTPRequestHandler
import os
import sys
import psutil
import requests

if __name__ == '__main__':
    worker_location = sys.argv[1]
    f = open('nodes.txt', 'r')
    hosts = [l.strip() for l in f]
    f.close()

    try:
        while True:
            # Obtaining the CPU Load per core
            loadPercentage = psutil.cpu_percent(interval=3)

            # loadAverage = os.getloadavg()
            print("CPU Load {}".format(loadPercentage))
            for host in hosts:

                # Requesting GET to server
                try:
                    requests.get('http://{}/load/{}/{}'.format(host, worker_location, loadPercentage), timeout=0.1).text
                except requests.exceptions.ConnectionError:
                    print('Node at {} is down.'.format(host))

    except KeyboardInterrupt:
        pass

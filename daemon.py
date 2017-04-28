import os
import sys
import psutil
import requests

if __name__ == '__main__':
    # Read hosts
    worker_location = sys.argv[1]
    f = open('nodes.txt', 'r')
    hosts = [l.strip() for l in f]
    f.close()

    try:
        while True:
            # Obtaining the CPU Load
            loadPercentage = psutil.cpu_percent(interval=3)

            print("CPU Load {}".format(loadPercentage))
            for host in hosts:

                # Send cpu load
                try:
                    requests.get('http://{}/load/{}/{}'.format(host, worker_location, loadPercentage), timeout=0.1).text
                except requests.exceptions.ConnectionError:
                    print('Node at {} is down.'.format(host))

    except KeyboardInterrupt:
        pass

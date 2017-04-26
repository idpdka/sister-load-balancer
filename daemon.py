from http.server import HTTPServer, BaseHTTPRequestHandler
import os
import psutil
import urllib.request


if __name__ == '__main__':
	file = open('addresses.txt', 'r') 

	try:
		while True:
			for line in file:
				urllib.request.urlopen(line).read()
				val = psutil.cpu_percent(interval=10, percpu=True)
				print("CPU Load per core for " + line)
				for i in range(len(val)):
					print("Core " + str(i) + " = "+ str(val[i]) + "%")
				print("\n")		
	except KeyboardInterrupt:
		pass

	file.close()




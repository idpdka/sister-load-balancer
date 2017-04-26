from http.server import HTTPServer, BaseHTTPRequestHandler
import os
import psutil
import urllib.request


if __name__ == '__main__':
	file = open('addresses.txt', 'r') 

	try:
		while True:
			for line in file:
				# Requesting GET to server
				urllib.request.urlopen(line).read()

				# Obtaining the CPU Load per core
				loadPercentage = psutil.cpu_percent(interval=10, percpu=True)
				
				# loadAverage = os.getloadavg()
				print("CPU Load per core for " + line)
				for i in range(len(loadPercentage)):
					print("Core " + str(i) + " = "+ str(loadPercentage[i]) + "%")
				# print("CPU Load Average : " + str(loadAverage))
				print("\n")		
	except KeyboardInterrupt:
		pass

	file.close()




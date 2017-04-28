# Sister-load-balancer
# Nama kelompok:
### Огонь по готовности "Ogon po gotovnosti"
# Anggota kelompok:
1. Muhammad Isham Azmansyah F - 13514014
2. Azka Hanif Imtiyaz - 13514086
3. I Dewa Putu Deny Krisna Amrita - 13514096

# Cara pemakaian:
1. Masukkan alamat IP dan port dari node yang akan dijalankan pada file "nodes.txt", dipisahkan dengan newline untuk setiap node.
2. Untuk setiap node pada IP adress masing masing:
* Buka direktori "/node".
* Jalankan command berikut ini secara berurutan:
```
npm install
```
```
npm run watch-compile
```
```
PORT=XXXX DEBUG=raft,route npm run watch-start
```
dengan XXXX merupakan port yang telah didefinisikan pada "nodes.txt".
3. Pada mesin yang akan dijadikan daemon, lakukan setup:
```
pip install psutil
```
```
pip install requests
```
4. Jalankan  command untuk menyalakan worker:
```
python worker.py
```
atau apabila ingin menjalankan worker.py dengan custom port:
```
python worker_port.py XXXX
```
5. Jalankan command untuk daemon:
```
python daemon.py IP_ADDRESS:PORT
```
dengan IP_ADDRESS dan PORT diganti dengan alamat IP dan port dijalankannya worker.
6. Buka browser dan masukkan URL 
```
IP_ADDRESS:PORT/prime/X
```
dengan IP_ADDRESS dan PORT diganti dengan alamat IP dan port dijalankannya node yang diinginkan lalu X merupakan argumen bilangan prima ke berapa yang diinginkan.
7. Kondisi masing masing node dapat dipantau melalui masing masing window dijalankannya node.
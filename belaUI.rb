=begin
    belaUI - web UI for the BELABOX project
    Copyright (C) 2020-2021 BELABOX project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
=end

require 'sinatra'
require 'sinatra/json'
require 'sinatra/reloader'
require 'json'
require 'digest'
require 'uri'
require 'net/http'

$setup = JSON.parse(File.read(__dir__ + '/setup.json'))
begin
  $config = JSON.parse(File.read(__dir__ + '/config.json'))
rescue
  $config = {}
end

def save_config
  File.write(__dir__ + '/config.json', $config.to_json)
end

def in_array(array, search)
  array.each_with_index do |el, idx|
    return idx if el == search
  end
  return -1
end

def get_modems
  modems = []

  addrs = `ip route show`
  addrs.each_line do |line|
    line = line.split(" ")
    if (srci = in_array(line, 'src')) >= 0
      ip = line[srci+1]
      i = line[2]
      rxb = File.read("/sys/class/net/#{i}/statistics/rx_bytes")
	  txb = File.read("/sys/class/net/#{i}/statistics/tx_bytes")
      modems.push({:i=>i, :ip=>ip, :txb=>txb.gsub("\n",''), :rxb=>rxb.gsub("\n",'')})
    end
  end
  modems
end

def get_temps
  temps = []

  type = `cat /sys/class/thermal/thermal_zone*/type`
  i = 0
  type.each_line do |line|
    if i > 0 && i <= 2
      type_name = `cat /sys/class/thermal/thermal_zone#{i}/type | tr -d '\n'`
      type_value = `cat /sys/class/thermal/thermal_zone#{i}/temp | tr -d '\n'`
      temps.push({:i=>i, :type_name=>type_name, :type_value=>type_value})
    end
	i = i+1
  end
  temps
end

def get_pipelines()
  pipelines = []
  pipelines += Dir["#{$setup['belacoder_path']}/pipeline/jetson/*"].sort if $setup['hw'] == 'jetson'
  pipelines += Dir["#{$setup['belacoder_path']}/pipeline/generic/*"].sort
  pipelines.each do |pipelineFile|
	text = File.read(pipelineFile)
	new_contents = text.gsub(/textoverlay [^!]* ![[:blank:]]*\R+/,'')
	File.open(pipelineFile, "w") {|filecontent| filecontent.puts new_contents }
  end
  pipelines.map { |pipeline|
    { 'file' => pipeline, 'id' => Digest::SHA1.hexdigest(pipeline) }
  }
end

def search_pipeline(id)
  get_pipelines.each do |pipeline|
    return pipeline if pipeline['id'] == id
  end
  return nil
end

def is_active
  `ps -aux |grep runner.rb |grep -v grep`.lines.count > 0
end 

def set_bitrate(params)
  return nil unless params[:min_br] and params[:max_br]
  min_br = params[:min_br].to_i
  max_br = params[:max_br].to_i
  return nil if min_br < 500 or min_br > 12000
  return nil if max_br < 500 or max_br > 12000
  return nil if min_br > max_br

  File.write($setup['bitrate_file'], "#{min_br*1000}\n#{max_br*1000}\n")

  return [min_br, max_br]
end

def update_bela()
  update_result = ""
  if(File.file?('../belacoder/version.json'))
    belacoder_version_remote = JSON.parse open('https://raw.githubusercontent.com/moo-the-cow/belacoder/master/version.json').read
	belacoder_version_local = JSON.parse open('../belacoder/version.json').read
	if(belacoder_version != belacoder_version_remote)
      `chmod +x ../belacoder/update_belacoder.sh && sh ../belacoder/update_belacoder.sh`
	  update_result += "belacoder "
	end
  else
    `chmod +x ../belacoder/update_belacoder.sh && sh ../belacoder/update_belacoder.sh`
	update_result += "belacoder "
  end
  if(File.file?('version.json'))
    belacoder_version_remote = JSON.parse open('https://raw.githubusercontent.com/moo-the-cow/belaUI/main/version.json').read
	belacoder_version_local = JSON.parse open('version.json').read
	if(belacoder_version != belacoder_version_remote)
      `chmod +x update_belaui.sh && sh update_belaui.sh`
	  update_result += "belaUI "
	end
  else
    `chmod +x update_belaui.sh && sh update_belaui.sh`
	update_result += "belaUI "
  end
  if(update_result == "")
    update_result = "no updates available"
  else
    update_result += "updated"
  end
  return update_result
end

get '/' do
  send_file File.expand_path('index.html', settings.public_folder)
end

get '/update' do
  json update_bela
end

get '/data' do
  all_data = { :active=>is_active, :modems=>get_modems, :temps=>get_temps}
  json all_data
end

get '/status' do
  json is_active
end

get '/modems' do
  json get_modems
end

get '/temps' do
  json get_temps
end

get '/pipelines' do
  json get_pipelines.map { |pipeline|
    if (pipeline['id'] == $config['pipeline'])
      { 'name' => File.basename(pipeline['file']), 'id' => pipeline['id'], 'selected' => true }
    else
      { 'name' => File.basename(pipeline['file']), 'id' => pipeline['id'] }
    end
  }
end

get '/config' do
  json $config
end

post '/stop' do
  system("pkill -f runner.rb")
  system("killall srtla_send")
  system("killall belacoder")
  json true
end

post '/start' do
  # delay
  error(400, "audio delay not specified") unless params[:delay]
  delay = params[:delay].to_i
  error(400, "invalid delay #{delay}") if delay > 2000 or delay < -2000

  # pipeline
  error(400, "pipeline not specified") unless params[:pipeline]
  pipeline = search_pipeline(params[:pipeline])
  error(400, "pipeline #{params[:pipeline]} not found") unless pipeline

  # bitrate
  if (bitrate = set_bitrate(params)) == nil
    error(400, "invalid bitrate range #{params[:min_br]} - #{params[:max_br]}")
  end

  # srt latency
  error(400, "SRT latency not specified") unless params[:srt_latency]
  srt_latency = params[:srt_latency].to_i
  error(400, "invalid SRT latency #{srt_latency} ms") if srt_latency < 100 or srt_latency > 10000

  # srt streamid
  error(400, "SRT streamid not specified") unless params[:srt_streamid]
  srt_streamid = params[:srt_streamid].strip

  # srtla addr & port
  error(400, "SRTLA address not specified") unless params[:srtla_addr]
  error(400, "SRTLA port not specified") unless params[:srtla_port]
  srtla_port = params[:srtla_port].to_i
  if srtla_port <= 0 or srtla_port > 0xFFFF
    error(400, "invalid SRTLA port #{srtla_port}")
  end
  begin
    srtla_addr = params[:srtla_addr].strip
    IPSocket.getaddress(srtla_addr)
    $config['srtla_addr'] = srtla_addr
  rescue
    error(400, "failed to resolve SRTLA addr #{params[:srtla_addr]}")
  end

  $config['delay'] = delay
  $config['pipeline'] = params[:pipeline]
  $config['min_br'] = bitrate[0]
  $config['max_br'] = bitrate[1]
  $config['srtla_port'] = srtla_port
  $config['srt_latency'] = srt_latency
  $config['srt_streamid'] = srt_streamid
  save_config()

  IO.popen([
    'ruby', "#{__dir__}/runner.rb",
     pipeline['file'],
     delay.to_s,
     srtla_addr,
     srtla_port.to_s,
     srt_latency.to_s,
     srt_streamid])

  json true
end

post '/bitrate' do
  return json true unless is_active
  error 400 if !set_bitrate(params)
  system("killall -HUP belacoder")
  json true
end

post '/command' do
  error 400 unless ["poweroff", "reboot", "update"].include?(params[:cmd])
  if(params[:cmd] == "update")
    json update_bela
  else
    fork { sleep 1 and exec(params[:cmd]) }
    json true
  end
end

get '/generate_204' do
  redirect "http://#{request.host}/"
end

get '/v1/hello.html' do
  return 'Success'
end

if $setup['autostart'] == true
   Thread.new do
	  sleep 1
	  uri = URI.parse("http://127.0.0.1/start")
	  http = Net::HTTP.new(uri.host, uri.port)
	  formdata = "pipeline="+$config['pipeline']+"&delay="+$config['delay'].to_s+"&min_br="+$config['min_br'].to_s+"&max_br="+$config['max_br'].to_s+"&srtla_addr="+$config['srtla_addr']+"&srtla_port="+$config['srtla_port'].to_s+"&srt_streamid="+$config['srt_streamid']+"&srt_latency="+$config['srt_latency'].to_s
	  res = http.post(uri.path, formdata)
	  printf res.to_s.concat("\n"), 3
   end
end

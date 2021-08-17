function getRandomInt(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min) + min); //The maximum is exclusive and the minimum is inclusive
}

if(window.location.hash.substring(1) == "graph-temp")
{
	$('#content').hide();
	$('#tempChart').appendTo('body');
}
else if(window.location.hash.substring(1) == "graph-bitrate")
{
	$('#content').hide();
	$('#bitrateChart').appendTo('body');
}

/*
function hashHandler() {
  console.log(window.location.hash.substring(1));
  console.log('The hash has changed!');
}

window.addEventListener('hashchange', hashHandler, false);
*/
/*
$("#startStop").on("click", function(event){
	$("#bitrateChart").toggle();
});

$("#bitrateChart").hide();
*/

/** bitrate **/
const DATA_COUNT = 12;
const labels_bitrate = [];
for (let i = 0; i < DATA_COUNT; ++i) {
  labels_bitrate.push(i.toString());
}
const data_bitrate = {
  labels: labels_bitrate,
  datasets: []
};
let last_modem;
const config_bitrate = {
  type: 'line',
  data: data_bitrate,
  options: {
	responsive: true,
	plugins: {
	  legend: {
		position: 'bottom',
	  },
	  title: {
		display: true,
		text: 'Bitrate Graph by m_o_o_'
	  }
	},
	scales: {
	  x: {
		display: true,
		title: {
		  display: true
		}
	  },
	  y: {
		display: true,
		title: {
		  display: true,
		  text: 'Kbps'
		},
		suggestedMin: 0,
		suggestedMax: 3000
	  }
	}
  },
};
var bitrateChart = new Chart(
	document.getElementById('bitrateChart'),
	config_bitrate
);
/** temperature **/
const labels_temp = [];
for (let i = 0; i < DATA_COUNT; ++i) {
  labels_temp.push(i.toString());
}
const data_temp = {
  labels: labels_temp,
  datasets: []
};
const config_temp = {
  type: 'line',
  data: data_temp,
  options: {
	responsive: true,
	plugins: {
	  legend: {
		position: 'bottom',
	  },
	  title: {
		display: true,
		text: 'Temperature Graph by m_o_o_'
	  }
	},
	scales: {
	  x: {
		display: true,
		title: {
		  display: true
		}
	  },
	  y: {
		display: true,
		title: {
		  display: true,
		  text: '°C'
		},
		suggestedMin: 10,
		suggestedMax: 100
	  }
	}
  },
};
var tempChart = new Chart(
	document.getElementById('tempChart'),
	config_temp
);
/** Graph methods **/
$.getJSON("/data", function(data) {
	data.modems.forEach((item, index) => {
		let txb = 0;
		//R1=item.rxb
		//T1=item.txb
		//sleep 1
		//R2=item.rxb
		//T2=item.txb
		//tot=(( (R2 + T2 - R1 - T1) / 1024 ))
		bitrateChart.data.datasets[index] = {
			label: `${item.i} (${item.ip})`,
			backgroundColor: `rgb(0, ${getRandomInt(0,255)}, ${getRandomInt(0,255)})`,
			borderColor: `rgb(0, ${getRandomInt(0,255)}, ${getRandomInt(0,255)})`,
			data: [txb],
		  };
	 });
	bitrateChart.update(); 
	last_modem = data;
	/** temperature **/
	data.temps.forEach((item, index) => {
		tempval = item.type_value / 1000;
		tempChart.data.datasets[index] = {
			label: `(${item.i}) ${item.type_name}`,
			backgroundColor: `rgb(0, ${getRandomInt(0,255)}, ${getRandomInt(0,255)})`,
			borderColor: `rgb(0, ${getRandomInt(0,255)}, ${getRandomInt(0,255)})`,
			data: [tempval],
		  };
	});
	tempChart.update();
	
	setInterval(function(){
		$.getJSON("/data", function(data) {
			data.modems.forEach((item, index) => {
			let txb = 0;
			if (last_modem && index in last_modem && "txb" in last_modem[index] && "rxb" in last_modem[index]) {
			  txb = item.txb - last_modem[index].txb;
			  txb = Math.round((txb * 8) / 1024);
			}
			if(bitrateChart.data.datasets[index].data.length >= DATA_COUNT)
			{
				bitrateChart.data.datasets[index].data.shift();
			}
			bitrateChart.data.datasets[index].data.push(txb);
		 });
		 bitrateChart.update(); 
		 last_modem = data.modems;
		 /** temperature **/
		 data.temps.forEach((item, index) => {
			//console.log(tempChart.data.datasets[index].data);
			tempval = item.type_value / 1000;
			if(tempChart.data.datasets[index].data.length >= DATA_COUNT)
			{
				tempChart.data.datasets[index].data.shift();
			}
			tempChart.data.datasets[index].data.push(tempval);
		 });
		 tempChart.update(); 
		});
	}, 1000);
});
